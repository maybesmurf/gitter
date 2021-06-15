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
const config = env.config;
const errorReporter = env.errorReporter;

const store = require('./store');
const transformMatrixEventContentIntoGitterMessage = require('./transform-matrix-event-content-into-gitter-message');
const MatrixUtils = require('./matrix-utils');
const GitterUtils = require('./gitter-utils');
const parseGitterMxid = require('./parse-gitter-mxid');
const isGitterRoomIdAllowedToBridge = require('./is-gitter-room-id-allowed-to-bridge');
const discoverMatrixDmUri = require('./discover-matrix-dm-uri');

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
  constructor(
    matrixBridge,
    // The backing user we are sending messages with on the Gitter side
    gitterBridgeBackingUsername = config.get('matrix:bridge:gitterBridgeBackingUsername'),
    matrixDmGroupUri = 'matrix'
  ) {
    assert(matrixBridge, 'Matrix bridge required');
    assert(
      gitterBridgeBackingUsername,
      'gitterBridgeBackingUsername required (the bot user on the Gitter side that bridges messages like gitter-badger or matrixbot)'
    );

    this.matrixBridge = matrixBridge;
    this._gitterBridgeBackingUsername = gitterBridgeBackingUsername;
    this.matrixUtils = new MatrixUtils(matrixBridge);
    this.gitterUtils = new GitterUtils(matrixBridge, gitterBridgeBackingUsername, matrixDmGroupUri);
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

    const matrixEventId = event.event_id;
    const matrixRoomId = event.room_id;

    // Reject any events that are too old
    if (Date.now() - event.origin_server_ts > MAX_EVENT_ACCEPTANCE_WINDOW) {
      logger.warn(
        `Ignoring old Matrix event that arrived after the MAX_EVENT_ACCEPTANCE_WINDOW, matrixEventId=${matrixEventId}, matrixRoomId=${matrixRoomId}`
      );
      stats.event('matrix_bridge.ignored_old_matrix_event', {
        matrixRoomId,
        matrixEventId
      });
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

    const gitterBridgeUser = await userService.findByUsername(this._gitterBridgeBackingUsername);

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

  // Helper to invite the Gitter user back to the DM room when a new message comes in.
  // Returns true if the user was invited, false if failed to invite, null if no inviting needed
  async inviteGitterUserToDmRoomIfNeeded(gitterRoom, matrixRoomId) {
    let gitterUserId;
    let gitterUser;
    try {
      // We only need to invite people if this is a Matrix DM
      const matrixDm = discoverMatrixDmUri(gitterRoom.lcUri);
      if (!matrixDm) {
        return null;
      }

      gitterUserId = matrixDm.gitterUserId;
      gitterUser = await userService.findById(gitterUserId);
      assert(gitterUser);

      // Join the Gitter user to the Gitter<->Matrix DM room
      await roomService.joinRoom(gitterRoom, gitterUser, {
        tracking: { source: 'matrix-dm' }
      });
      return true;
    } catch (err) {
      // Let's allow this to fail as sending the message regardless
      // of the person being there is still important
      logger.warn(
        `Unable to invite Gitter user (${gitterUserId}) back to DM room gitterRoom=${gitterRoom.lcUri} (${gitterRoom.id}) matrixRoomId=${matrixRoomId}`,
        { exception: err }
      );
      errorReporter(
        err,
        {
          operation: 'matrixEventHandler.inviteGitterUserToDmRoomIfNeeded',
          data: {
            gitterUserId,
            gitterRoomId: gitterRoom.id,
            gitterRoomLcUri: gitterRoom.lcUri,
            matrixRoomId
          }
        },
        { module: 'gitter-to-matrix-bridge' }
      );

      if (gitterUserId) {
        logger.info(
          `Sending notice to matrixRoomId=${matrixRoomId} that we were unable to invite the Gitter user(${gitterUserId}) back to the DM room`
        );

        let unableToInviteErrorMessage = `Unable to invite Gitter user back to DM room. They probably won't know about the message you just sent.`;
        if (gitterUser.isRemoved && gitterUser.isRemoved()) {
          unableToInviteErrorMessage =
            'Unable to invite Gitter user back to DM room because they deleted their account.';
        }

        const matrixContent = {
          body: unableToInviteErrorMessage,
          msgtype: 'm.notice'
        };

        // We have to use the Gitter user intent because the bridge bot
        // is not in the DM conversation. Only 2 people can be in the `is_direct`
        // DM for it to be catogorized under the "people" heading in Element.
        const mxid = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);
        const intent = this.matrixBridge.getIntent(mxid);
        await intent.sendMessage(matrixRoomId, matrixContent);
      }
    }

    return false;
  }

  // eslint-disable-next-line max-statements, complexity
  async handleChatMessageCreateEvent(event) {
    // If someone is passing us mangled events, just ignore them.
    if (!validateEventForMessageCreateEvent(event)) {
      return null;
    }

    const matrixEventId = event.event_id;
    const matrixRoomId = event.room_id;

    const gitterRoomId = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
    if (!gitterRoomId) {
      debug(`Ignoring message for Matrix room that is not bridged ${matrixRoomId}`);
      return null;
    }

    const gitterRoom = await troupeService.findById(gitterRoomId);

    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoom.id || gitterRoom._id);
    if (!allowedToBridge) {
      return null;
    }

    // The Gitter user may have left the room for the Matrix DM room.
    // So let's invite them back to the room so they can see the new message for them.
    if (
      // Suppress any loop that can come from the bridge sending its own messages
      //  in the room from a result of this action.
      event.sender !== this.matrixUtils.getMxidForMatrixBridgeUser()
    ) {
      await this.inviteGitterUserToDmRoomIfNeeded(gitterRoom, matrixRoomId);
    }

    const gitterBridgeUser = await userService.findByUsername(this._gitterBridgeBackingUsername);

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

  async getOrCreateGitterDmRoomAndHandleAssociation(matrixRoomId, gitterUser, otherPersonMxid) {
    const gitterDmRoom = await this.gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
      gitterUser,
      otherPersonMxid
    );

    // If the Matrix user previously DM'ed the Gitter user from a different room,
    // send a notice that the old room won't bridge anymore and to use the new room.
    const previousMatrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterDmRoom._id);
    if (previousMatrixRoomId && previousMatrixRoomId !== matrixRoomId) {
      const matrixContent = {
        body: `This DM will no longer bridge to Gitter. Please use the new DM room -> https://matrix.to/#/${matrixRoomId}`,
        msgtype: 'm.notice'
      };

      logger.info(
        `Sending notice to previousMatrixRoomId=${previousMatrixRoomId} that it will no longer bridge because matrixRoomId=${matrixRoomId} is the new DM room`
      );
      // We have to use the Gitter user intent because the bridge bot
      // is not in the DM conversation. Only 2 people can be in the `is_direct`
      // DM for it to be catogorized under the "people" heading in Element.
      const gitterUserId = gitterUser.id || gitterUser._id;
      const mxid = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);
      const intent = this.matrixBridge.getIntent(mxid);
      await intent.sendMessage(previousMatrixRoomId, matrixContent);
    }

    // And store the new association
    logger.info(
      `Storing bridged DM room (Gitter room id=${gitterDmRoom._id} -> Matrix room_id=${matrixRoomId}): ${gitterDmRoom.lcUri}`
    );
    await store.storeBridgedRoom(gitterDmRoom._id, matrixRoomId);

    return gitterDmRoom;
  }

  async handleInvitationEvent(event) {
    const matrixRoomId = event.room_id;
    if (event.state_key === this.matrixUtils.getMxidForMatrixBridgeUser()) {
      logger.info(
        `Our Matrix bridge bot user was invited to a room, let's join it (room_id=${matrixRoomId})`
      );
      const intent = this.matrixBridge.getIntent();
      await intent.join(matrixRoomId);
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
      await intent.join(matrixRoomId);

      logger.info(
        `Joined the bridged Gitter user (MXID=${event.state_key}) to the Matrix DM room (${matrixRoomId})`
      );

      const gitterDmRoom = await this.getOrCreateGitterDmRoomAndHandleAssociation(
        matrixRoomId,
        gitterUser,
        event.sender
      );

      logger.info(
        `Done setting up DM room between Gitter user (username=${gitterUser.username}, userId=${parsedGitterMxid.userId}) and Matrix user (${event.sender}) -> gitterRoomId=${gitterDmRoom._id}, gitterRoomLcUri=${gitterDmRoom.lcUri}`
      );

      return null;
    }

    return null;
  }
}

module.exports = MatrixEventHandler;
