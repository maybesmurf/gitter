'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:matrix-event-handler');
const assert = require('assert');
const chatService = require('gitter-web-chats');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomService = require('gitter-web-rooms');
const userService = require('gitter-web-users');
const generatePermalink = require('gitter-web-shared/chat/generate-permalink');
const env = require('gitter-web-env');
const stats = env.stats;
const logger = env.logger;

const store = require('./store');
const transformMatrixEventContentIntoGitterMessage = require('./transform-matrix-event-content-into-gitter-message');
const MatrixUtils = require('./matrix-utils');
const GitterUtils = require('./gitter-utils');
const parseGitterMxid = require('./parse-gitter-mxid');
const isGitterRoomIdAllowedToBridge = require('./is-gitter-room-id-allowed-to-bridge');

// 30 minutes in milliseconds
const MAX_EVENT_ACCEPTANCE_WINDOW = 1000 * 60 * 30;

function validateEventForMessageCreateEvent(event) {
  return !event.state_key && event.sender && event.content && event.content.body;
}

function validateEventForMessageEditEvent(event) {
  return (
    !event.state_key &&
    event.sender &&
    event.content &&
    event.content['m.relates_to'] &&
    event.content['m.relates_to'].rel_type === 'm.replace' &&
    event.content['m.new_content'] &&
    event.content['m.new_content'].body &&
    // Only text edits please
    (event.content['m.new_content'].msgtype === 'm.text' ||
      event.content['m.new_content'].msgtype === 'm.emote') &&
    event.content['m.relates_to'] &&
    event.content['m.relates_to'].event_id
  );
}

function validateEventForMessageDeleteEvent(event) {
  return !event.state_key && event.sender && event.redacts;
}

// If the matrix event is replying to someone else's message,
// find the associated bridged Gitter message and add it to the correct
// threaded conversation.
async function findGitterThreadParentIdForMatrixEvent(event) {
  let parentId = undefined;
  if (
    event.content['m.relates_to'] &&
    event.content['m.relates_to']['m.in_reply_to'] &&
    event.content['m.relates_to']['m.in_reply_to'].event_id
  ) {
    const inReplyToMatrixEventId = event.content['m.relates_to']['m.in_reply_to'].event_id;
    const inReplyToGitterMessageId = await store.getGitterMessageIdByMatrixEventId(
      event.room_id,
      inReplyToMatrixEventId
    );

    if (!inReplyToGitterMessageId) {
      return undefined;
    }

    const chatMessage = await chatService.findById(inReplyToGitterMessageId);

    if (!chatMessage) {
      return undefined;
    }
    // If you replied to a message that is already in a thread, put the reply in the thread under the parent instead
    else if (chatMessage.parentId) {
      parentId = chatMessage.parentId;
    }
    // Otherwise, you are already replying to a top-level message which is good in our book
    else {
      parentId = inReplyToGitterMessageId;
    }
  }

  return parentId;
}

// Because the Gitter community or room name can have underscores in it
// and we replace forward slashes with underscores in room aliases,
// it's ambiguous where we need to put the forward slash back in.
//
// This function will replace each spot where an underscore is with
// a forward slash and check if it exists on Gitter. If it exists, return that room.
async function findGitterRoomFromAliasLocalPart(aliasLocalpart) {
  // Find all the places where an underscore exists
  const underscoreIndexList = [];
  aliasLocalpart.replace(/_/g, (match, offset) => {
    underscoreIndexList.push(offset);
  });

  // Loop through each place where an underscore is, replace it with a forward slash,
  // and check if that room exists on Gitter
  for (const underscoreIndex of underscoreIndexList) {
    const uri = `${aliasLocalpart.substring(0, underscoreIndex)}/${aliasLocalpart.substring(
      underscoreIndex + 1,
      aliasLocalpart.length
    )}`;

    debug(`findGitterRoomFromAliasLocalPart() checking if uri=${uri} exists`);
    const gitterRoom = await troupeService.findByUri(uri);
    if (!gitterRoom) {
      continue;
    }

    debug(`findGitterRoomFromAliasLocalPart() found gitterRoom=${gitterRoom.uri}`);
    return gitterRoom;
  }
}

class MatrixEventHandler {
  constructor(matrixBridge, gitterBridgeUsername) {
    assert(matrixBridge, 'Matrix bridge required');
    assert(
      gitterBridgeUsername,
      'gitterBridgeUsername required (the bot user on the Gitter side that bridges messages like gitter-badger or matrixbot)'
    );

    this.matrixBridge = matrixBridge;
    this._gitterBridgeUsername = gitterBridgeUsername;
    this.matrixUtils = new MatrixUtils(matrixBridge);
    this.gitterUtils = new GitterUtils(gitterBridgeUsername);
  }

  async onAliasQuery(alias, aliasLocalpart) {
    debug('onAliasQuery', alias, aliasLocalpart);

    const gitterRoom = await findGitterRoomFromAliasLocalPart(aliasLocalpart);
    if (!gitterRoom) {
      return null;
    }

    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoom.id || gitterRoom._id);
    if (!allowedToBridge) {
      return null;
    }

    const matrixRoomId = await this.matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoom._id);

    return {
      roomId: matrixRoomId
    };
  }

  async onEventData(event) {
    debug('onEventData', event);

    // Reject any events that are too old
    if (Date.now() - event.origin_server_ts > MAX_EVENT_ACCEPTANCE_WINDOW) {
      return null;
    }

    if (
      event.type === 'm.room.message' &&
      event.content &&
      event.content['m.relates_to'] &&
      event.content['m.relates_to'].rel_type === 'm.replace'
    ) {
      return await this.handleChatMessageEditEvent(event);
    }

    if (event.type === 'm.room.message') {
      return await this.handleChatMessageCreateEvent(event);
    }

    if (event.type === 'm.room.redaction') {
      return await this.handleChatMessageDeleteEvent(event);
    }

    if (event.type === 'm.room.member' && event.content && event.content.membership === 'invite') {
      return await this.handleInvitationEvent(event);
    }
  }

  async handleChatMessageEditEvent(event) {
    // If someone is passing us mangled events, just ignore them.
    if (!validateEventForMessageEditEvent(event)) {
      return null;
    }

    const matrixRoomId = event.room_id;
    const matrixEventId = event.content['m.relates_to'].event_id;
    const gitterMessageId = await store.getGitterMessageIdByMatrixEventId(
      matrixRoomId,
      matrixEventId
    );

    const chatMessage = await chatService.findById(gitterMessageId);
    const gitterRoom = await troupeService.findById(chatMessage.toTroupeId);

    const allowedToBridge = await isGitterRoomIdAllowedToBridge(chatMessage.toTroupeId);
    if (!allowedToBridge) {
      return null;
    }

    const gitterBridgeUser = await userService.findByUsername(this._gitterBridgeUsername);

    stats.event('matrix_bridge.chat_edit', {
      gitterRoomId: chatMessage.toTroupeId,
      chatMessage: chatMessage.id || chatMessage._id,
      matrixRoomId,
      matrixEventId: matrixEventId
    });

    const newText = await transformMatrixEventContentIntoGitterMessage(
      event.content['m.new_content'],
      event
    );

    // Create a new message for any events that are outside the Gitter edit window
    if (chatService.checkIfTimeIsOutsideEditWindow(chatMessage.sent)) {
      logger.info(
        `Matrix edit is too old to apply to original bridged Gitter message so we're sending a new message (event_id=${event.event_id} old_matrix_event_we_are_replacing=${matrixEventId} old_gitter_chat_id=${chatMessage.id})`
      );

      await chatService.newChatMessageToTroupe(gitterRoom, gitterBridgeUser, {
        parentId: chatMessage.parentId,
        virtualUser: chatMessage.virtualUser,
        text: `:point_up: [Edit](${generatePermalink(gitterRoom.uri, chatMessage.id)}): ${newText}`,
        status: chatMessage.status
      });

      return null;
    }

    await chatService.updateChatMessage(gitterRoom, chatMessage, gitterBridgeUser, newText);

    return null;
  }

  // eslint-disable-next-line max-statements
  async handleChatMessageCreateEvent(event) {
    // If someone is passing us mangled events, just ignore them.
    if (!validateEventForMessageCreateEvent(event)) {
      return null;
    }

    const matrixEventId = event.event_id;
    const matrixRoomId = event.room_id;

    const gitterRoomId = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
    const gitterRoom = await troupeService.findById(gitterRoomId);

    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoom.id || gitterRoom._id);
    if (!allowedToBridge) {
      return null;
    }

    const gitterBridgeUser = await userService.findByUsername(this._gitterBridgeUsername);

    stats.event('matrix_bridge.chat_create', {
      gitterRoomId,
      matrixRoomId,
      matrixEventId
    });

    const intent = this.matrixBridge.getIntent();
    // TODO: Use room membership events instead of profile and cache things
    let profile = {};
    try {
      profile = await intent.getProfileInfo(event.sender);
    } catch (err) {
      // no-op, the user just won't get any info
    }

    // Strip the @ sigil off the front if it exists
    const externalId = event.sender.replace(/^@/, '');

    // Get the first part of the MXID to use as the displayName if one wasn't provided
    let displayName = profile.displayname;
    if (!profile.displayname) {
      const splitMxid = externalId.split(':');
      displayName = splitMxid[0];
    }

    const inReplyToMatrixEventId =
      event.content['m.relates_to'] &&
      event.content['m.relates_to']['m.in_reply_to'] &&
      event.content['m.relates_to']['m.in_reply_to'].event_id;

    // Handle replies from Matrix and translate into Gitter threaded conversations
    const parentId = await findGitterThreadParentIdForMatrixEvent(event);

    // If we can't find the bridged Gitter chat message,
    // we are unable to put it in the appropriate threaded conversation.
    // Let's just put their message in the MMF and add a warning note about the problem.
    let fallbackReplyContent = '';
    if (inReplyToMatrixEventId && !parentId) {
      fallbackReplyContent = `> This message is replying to a [Matrix event](https://matrix.to/#/${matrixRoomId}/${inReplyToMatrixEventId}) but we were unable to find associated bridged Gitter message to put it in the appropriate threaded conversation.\n\n`;
    }

    const isStatusMessage = event.content.msgtype === 'm.emote';

    const newText = await transformMatrixEventContentIntoGitterMessage(event.content, event);
    const resultantText = `${fallbackReplyContent}${newText}`;

    const newChatMessage = await chatService.newChatMessageToTroupe(gitterRoom, gitterBridgeUser, {
      parentId,
      virtualUser: {
        type: 'matrix',
        externalId,
        displayName,
        avatarUrl: profile.avatar_url
          ? intent.getClient().mxcUrlToHttp(profile.avatar_url)
          : undefined
      },
      text: resultantText,
      status: isStatusMessage
    });

    // Store the message so we can reference it in edits and threads/replies
    await store.storeBridgedMessage(newChatMessage, matrixRoomId, matrixEventId);

    return null;
  }

  async handleChatMessageDeleteEvent(event) {
    // If someone is passing us mangled events, just ignore them.
    if (!validateEventForMessageDeleteEvent(event)) {
      return null;
    }

    const matrixRoomId = event.room_id;
    const matrixEventId = event.redacts;
    const gitterMessageId = await store.getGitterMessageIdByMatrixEventId(
      matrixRoomId,
      matrixEventId
    );

    const chatMessage = await chatService.findById(gitterMessageId);
    const gitterRoom = await troupeService.findById(chatMessage.toTroupeId);

    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoom.id || gitterRoom._id);
    if (!allowedToBridge) {
      return null;
    }

    stats.event('matrix_bridge.chat_delete', {
      gitterRoomId: chatMessage.toTroupeId,
      chatMessage: chatMessage.id || chatMessage._id,
      matrixRoomId,
      matrixEventId: matrixEventId
    });

    await chatService.deleteMessageFromRoom(gitterRoom, chatMessage);

    return null;
  }

  async handleInvitationEvent(event) {
    if (event.state_key === this.matrixUtils.getMxidForMatrixBridgeUser()) {
      logger.info(
        `Our Matrix bridge bot user was invited to a room, let's join it (room_id=${event.room_id})`
      );
      const intent = this.matrixBridge.getIntent();
      await intent.join(event.room_id);
      return null;
    }

    // Someone started a DM conversation with a Gitter user on Matrix
    const parsedGitterMxid = parseGitterMxid(event.state_key);
    if (event.content.is_direct && parsedGitterMxid) {
      const gitterUser = await userService.findById(parsedGitterMxid.userId);
      if (!gitterUser) {
        throw new Error(
          `Unable to find Gitter user with userId=${parsedGitterMxid.userId} (MXID=${event.state_key}, parsedGitterMxid=${parsedGitterMxid}) that ${event.sender} is trying to start a one to one (DM) conversation with`
        );
      }

      logger.info(
        `${event.sender} from Matrix started a DM conversation with a Gitter user ${gitterUser.username} (userId=${parsedGitterMxid.userId}, MXID=${event.state_key})`
      );

      // Join the bridged Gitter user to the Matrix DM room
      const matrixId = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(
        parsedGitterMxid.userId
      );
      const intent = this.matrixBridge.getIntent(matrixId);
      await intent.join(event.room_id);

      logger.info(
        `Joined the bridged Gitter user (MXID=${event.state_key}) to the Matrix DM room (${event.room_id})`
      );

      const dmRoom = await this.gitterUtils.getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        event.room_id,
        parsedGitterMxid.userId,
        event.sender
      );

      logger.info(
        `Joining Gitter user (username=${gitterUser.username}, userId=${parsedGitterMxid.userId}) to the DM room on Gitter (gitterRoomId=${dmRoom._id}, gitterRoomLcUri=${dmRoom.lcUri})`
      );

      // Join the Gitter user to the new Gitter DM room
      await roomService.joinRoom(dmRoom, gitterUser, {
        tracking: { source: 'matrix-dm' }
      });

      logger.info(
        `Done setting up DM room between Gitter user (username=${gitterUser.username}, userId=${parsedGitterMxid.userId}) and Matrix user (${event.sender}) -> gitterRoomId=${dmRoom._id}, gitterRoomLcUri=${dmRoom.lcUri}`
      );

      return null;
    }

    return null;
  }
}

module.exports = MatrixEventHandler;
