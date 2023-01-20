'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:gitter-bridge');
const assert = require('assert');
const StatusError = require('statuserror');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const appEvents = require('gitter-web-appevents');
const userService = require('gitter-web-users');
const chatService = require('gitter-web-chats');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const policyFactory = require('gitter-web-permissions/lib/policy-factory');
const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const config = env.config;
const errorReporter = env.errorReporter;

const store = require('./store');
const MatrixUtils = require('./matrix-utils');
const generateMatrixContentFromGitterMessage = require('./generate-matrix-content-from-gitter-message');
const checkIfDatesSame = require('./check-if-dates-same');
const isGitterRoomIdAllowedToBridge = require('./is-gitter-room-id-allowed-to-bridge');
const discoverMatrixDmUri = require('./discover-matrix-dm-uri');
const getMxidForGitterUser = require('./get-mxid-for-gitter-user');

class GitterBridge {
  constructor(
    matrixBridge,
    // The backing user we are sending messages with on the Gitter side
    gitterBridgeBackingUsername = config.get('matrix:bridge:gitterBridgeBackingUsername')
  ) {
    assert(matrixBridge);
    this.matrixBridge = matrixBridge;
    this.matrixUtils = new MatrixUtils(matrixBridge);
    this._gitterBridgeBackingUsername = gitterBridgeBackingUsername;

    this.onDataChangeWithBind = this.onDataChange.bind(this);
  }

  async start() {
    appEvents.onDataChange2(this.onDataChangeWithBind);
  }

  // Stop the listeners and processing any more events
  async stop() {
    appEvents.removeListener('dataChange2', this.onDataChangeWithBind);
  }

  // eslint-disable-next-line complexity, max-statements
  async onDataChange(data) {
    try {
      debug('onDataChange', data);
      stats.eventHF('gitter_bridge.event_received');
      // Ignore data without a URL or model
      if (!data.url || !data.model) {
        throw new StatusError(
          400,
          'Gitter data from onDataChange2(data) did not include URL or model'
        );
      }

      if (data.type === 'chatMessage') {
        const [, gitterRoomId] = data.url.match(/\/rooms\/([a-f0-9]+)\/chatMessages/) || [];
        if (gitterRoomId && data.operation === 'create') {
          await this.handleChatMessageCreateEvent(gitterRoomId, data.model);
        } else if (gitterRoomId && data.operation === 'update') {
          await this.handleChatMessageEditEvent(gitterRoomId, data.model);
        } else if (gitterRoomId && data.operation === 'remove') {
          await this.handleChatMessageRemoveEvent(gitterRoomId, data.model);
        }
      }

      if (data.type === 'room') {
        const [, gitterRoomId] = data.url.match(/\/rooms\/([a-f0-9]+)/) || [];
        if (gitterRoomId && (data.operation === 'patch' || data.operation === 'update')) {
          await this.handleRoomUpdateEvent(gitterRoomId, data.model);
        } else if (gitterRoomId && data.operation === 'remove') {
          await this.handleRoomRemoveEvent(gitterRoomId, data.model);
        }
      }

      if (data.type === 'room.sd') {
        const [, gitterRoomId] = data.url.match(/\/rooms\/([a-f0-9]+)/) || [];
        if (gitterRoomId && (data.operation === 'patch' || data.operation === 'update')) {
          await this.handleRoomSecurityDescriptorUpdateEvent(gitterRoomId, data.model);
        }
      }

      if (data.type === 'group.sd') {
        const [, gitterGroupId] = data.url.match(/\/groups\/([a-f0-9]+)/) || [];
        if (gitterGroupId && (data.operation === 'patch' || data.operation === 'update')) {
          await this.handleGroupSecurityDescriptorUpdateEvent(gitterGroupId, data.model);
        }
      }

      if (data.type === 'user') {
        const [, gitterRoomId] = data.url.match(/\/rooms\/([a-f0-9]+)\/users/) || [];
        if (gitterRoomId && data.operation === 'create') {
          await this.handleUserJoiningRoom(gitterRoomId, data.model);
        } else if (gitterRoomId && data.operation === 'remove') {
          await this.handleUserLeavingRoom(gitterRoomId, data.model);
        }
      }

      if (data.type === 'ban') {
        const [, gitterRoomId] = data.url.match(/\/rooms\/([a-f0-9]+)\/bans/) || [];
        if ((gitterRoomId && data.operation === 'create') || data.operation === 'remove') {
          await this.handleRoomBanEvent(gitterRoomId, data.model, data.operation);
        }
      }

      // TODO: Handle user data change and update Matrix user

      stats.eventHF('gitter_bridge.event.success');
    } catch (err) {
      logger.error(
        `Error while processing Gitter bridge event (url=${data && data.url}, id=${data &&
          data.model &&
          data.model.id}): ${err}`,
        {
          exception: err,
          data
        }
      );
      stats.eventHF('gitter_bridge.event.fail');
      errorReporter(
        err,
        { operation: 'gitterBridge.onDataChange', data: data },
        { module: 'gitter-to-matrix-bridge' }
      );
    }

    return null;
  }

  // Helper to invite the Matrix user back to the DM room when a new message comes in.
  // Returns true if the user was invited, false if failed to invite, null if no inviting needed
  async inviteMatrixUserToDmRoomIfNeeded(gitterRoomId, matrixRoomId) {
    let otherPersonMxid;
    let gitterRoom;
    try {
      gitterRoom = await troupeService.findById(gitterRoomId);
      assert(gitterRoom);

      // We only need to invite people if this is a Matrix DM
      const matrixDm = discoverMatrixDmUri(gitterRoom.lcUri);
      if (!matrixDm) {
        return null;
      }
      const gitterUserId = matrixDm.gitterUserId;
      otherPersonMxid = matrixDm.virtualUserId;

      const gitterUserMxid = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(
        gitterUserId
      );
      const intent = this.matrixBridge.getIntent(gitterUserMxid);

      // Only invite back if they have left
      const memberContent = await intent.getStateEvent(
        matrixRoomId,
        'm.room.member',
        otherPersonMxid,
        // returnNull=true
        true
      );
      if (!memberContent || (memberContent && memberContent.membership === 'leave')) {
        // Invite the Matrix user to the Matrix DM room
        await intent.invite(matrixRoomId, otherPersonMxid);
      }

      return true;
    } catch (err) {
      // Let's allow this to fail as sending the message regardless
      // of the person being there is still important
      logger.warn(
        `Unable to invite Matrix user (${otherPersonMxid}) back to Matrix DM room matrixRoomId=${matrixRoomId} gitterRoomId=${gitterRoomId}`,
        { exception: err }
      );
      errorReporter(
        err,
        {
          operation: 'gitterBridge.inviteMatrixUserToDmRoomIfNeeded',
          data: {
            gitterRoomId,
            matrixRoomId,
            otherPersonMxid
          }
        },
        { module: 'gitter-to-matrix-bridge' }
      );

      if (gitterRoom) {
        logger.info(
          `Sending notice to gitterRoomId=${gitterRoomId} that we were unable to invite the Matrix user(${otherPersonMxid}) back to the DM room`
        );

        const gitterBridgeUser = await userService.findByUsername(
          this._gitterBridgeBackingUsername
        );
        await chatService.newChatMessageToTroupe(gitterRoom, gitterBridgeUser, {
          text: `Unable to invite Matrix user back to DM room. They probably won't know about the message you just sent.`
        });
      }
    }

    return false;
  }

  // eslint-disable-next-line max-statements
  async handleChatMessageCreateEvent(gitterRoomId, model) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    // Supress any echo that comes from Matrix bridge itself creating new messages
    if (model.virtualUser && model.virtualUser.type === 'matrix') {
      return null;
    }

    const matrixRoomId = await this.matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);

    if (!model.fromUser) {
      throw new StatusError(400, 'message.fromUser does not exist');
    }

    // The Matrix user may have left the Matrix DM room.
    // So let's invite them back to the room so they can see the new message for them.
    if (
      // Suppress any loop that can come from the bridge sending its own messages
      //  in the room from a result of this action.
      model.fromUser.username !== this._gitterBridgeBackingUsername
    ) {
      await this.inviteMatrixUserToDmRoomIfNeeded(gitterRoomId, matrixRoomId);
    }

    const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, model);

    // Send the message to the Matrix room
    const matrixId = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(model.fromUser.id);
    const intent = this.matrixBridge.getIntent(matrixId);
    logger.info(
      `Sending message to Matrix room (Gitter gitterRoomId=${gitterRoomId} -> Matrix gitterRoomId=${matrixRoomId}) (via user mxid=${matrixId})`
    );
    stats.event('gitter_bridge.chat_create', {
      gitterRoomId,
      gitterChatId: model.id,
      matrixRoomId,
      mxid: matrixId
    });
    const { event_id } = await intent.sendMessage(matrixRoomId, matrixContent);

    // Store the message so we can reference it in edits and threads/replies
    logger.info(
      `Storing bridged message (Gitter message id=${model.id} -> Matrix matrixRoomId=${matrixRoomId} event_id=${event_id})`
    );
    await store.storeBridgedMessage(model, matrixRoomId, event_id);

    return null;
  }

  async handleChatMessageEditEvent(gitterRoomId, model) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    // Supress any echo that comes from Matrix bridge itself creating new messages
    if (model.virtualUser && model.virtualUser.type === 'matrix') {
      return null;
    }

    const bridgedMessageEntry = await store.getBridgedMessageEntryByGitterMessageId(model.id);

    // No matching message on the Matrix side. Let's just ignore the edit as this is some edge case.
    if (!bridgedMessageEntry || !bridgedMessageEntry.matrixEventId) {
      debug(
        `Ignoring message edit from Gitter side(id=${model.id}) because there is no associated Matrix event ID`
      );
      stats.event('matrix_bridge.ignored_gitter_message_edit', {
        gitterMessageId: model.id
      });
      return null;
    }

    // Check if the message was actually updated.
    // If there was an `update` data2 event and there was no timestamp change here,
    // it is probably just an update to `threadMessageCount`, etc which we don't need to propogate
    //
    // We use this special date comparison function because:
    //  - `bridgedMessageEntry.editedAt` from the database is a `Date` object{} or `null`
    //  - `model.editedAt` from the event is a `string` or `undefined`
    if (checkIfDatesSame(bridgedMessageEntry.editedAt, model.editedAt)) {
      return null;
    }

    const matrixRoomId = await this.matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);

    const matrixId = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(model.fromUser.id);
    const intent = this.matrixBridge.getIntent(matrixId);
    stats.event('gitter_bridge.chat_edit', {
      gitterRoomId,
      gitterChatId: model.id,
      matrixRoomId,
      mxid: matrixId
    });

    const matrixContent = {
      body: `* ${model.text}`,
      format: 'org.matrix.custom.html',
      formatted_body: `* ${model.html}`,
      msgtype: 'm.text',
      'm.new_content': {
        body: model.text,
        format: 'org.matrix.custom.html',
        formatted_body: model.html,
        msgtype: 'm.text'
      },
      'm.relates_to': {
        event_id: bridgedMessageEntry.matrixEventId,
        rel_type: 'm.replace'
      }
    };
    await intent.sendMessage(matrixRoomId, matrixContent);

    // Update the timestamps to compare again next time
    await store.storeUpdatedBridgedGitterMessage(model);

    return null;
  }

  async handleChatMessageRemoveEvent(gitterRoomId, model) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    // Supress any echo that comes from Matrix bridge itself creating new messages
    if (model.virtualUser && model.virtualUser.type === 'matrix') {
      return null;
    }

    const matrixEventId = await store.getMatrixEventIdByGitterMessageId(model.id);

    // No matching message on the Matrix side. Let's just ignore the remove as this is some edge case.
    if (!matrixEventId) {
      debug(
        `Ignoring message removal for id=${model.id} from Gitter because there is no associated Matrix event ID`
      );
      stats.event('matrix_bridge.ignored_gitter_message_remove', {
        gitterMessageId: model.id
      });
      return null;
    }

    const matrixRoomId = await this.matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
    stats.event('gitter_bridge.chat_delete', {
      gitterRoomId,
      gitterChatId: model.id,
      matrixRoomId
    });

    const bridgeIntent = this.matrixBridge.getIntent();
    let senderIntent;
    try {
      const event = await bridgeIntent.getEvent(matrixRoomId, matrixEventId);
      senderIntent = this.matrixBridge.getIntent(event.sender);
    } catch (err) {
      logger.info(
        `handleChatMessageRemoveEvent(): Using bridging user intent because Matrix API call failed, intent.getEvent(${matrixRoomId}, ${matrixEventId})`
      );
      // We'll just use the bridge intent if we can't use their own user
      senderIntent = bridgeIntent;
    }

    try {
      await senderIntent.matrixClient.redactEvent(matrixRoomId, matrixEventId);
    } catch (err) {
      // If we fail to delete the message from the Gitter user, let's just do it
      // from the bridging user (Gitter badger). This will happen whenever a
      // Gitter user tries to delete a message from someone on Matrix
      // (M_FORBIDDEN: Application service cannot masquerade as this user.)
      await bridgeIntent.matrixClient.redactEvent(matrixRoomId, matrixEventId);
    }

    return null;
  }

  async handleRoomUpdateEvent(gitterRoomId /*, model*/) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    const matrixRoomId = await this.matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);

    await this.matrixUtils.ensureCorrectRoomState(matrixRoomId, gitterRoomId);
  }

  async handleRoomRemoveEvent(gitterRoomId /*, model*/) {
    const matrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (matrixRoomId) {
      await this.matrixUtils.shutdownMatrixRoom(matrixRoomId, {
        // The Gitter room has been removed by this point so we can't reference it. We
        // can force-remove safely because we never have to deal with ONE_TO_ONE rooms
        // which this option is protecting against
        forceRemoveIfNoGitterRoom: true
      });
    }

    // Also remove the historical Matrix room
    const matrixHistoricalRoomId = await store.getHistoricalMatrixRoomIdByGitterRoomId(
      gitterRoomId
    );
    if (matrixHistoricalRoomId) {
      await this.matrixUtils.shutdownMatrixRoom(matrixHistoricalRoomId, {
        // The Gitter room has been removed by this point so we can't reference it. We
        // can force-remove safely because we never have to deal with ONE_TO_ONE rooms
        // which this option is protecting against
        forceRemoveIfNoGitterRoom: true
      });
    }
  }

  // eslint-disable-next-line max-statements
  async handleUserJoiningRoom(gitterRoomId, model) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(gitterRoom);

    const matrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    // Just ignore the bridging join if the Matrix room hasn't been created yet
    if (!matrixRoomId) {
      return null;
    }

    const gitterUserId = model.id;
    assert(gitterUserId);
    const matrixId = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);
    assert(matrixId);

    try {
      const intent = this.matrixBridge.getIntent(matrixId);
      await intent.join(matrixRoomId);
    } catch (err) {
      // Create a new DM room on Matrix if the user is no longer able to join the old again
      if (err.message === 'Failed to join room') {
        const matrixDm = discoverMatrixDmUri(gitterRoom.lcUri);
        if (!matrixDm) {
          // If it's not a DM, just throw the error that happened
          // because we can't recover from that problem.
          throw err;
        }

        logger.warn(
          `Failed to join Gitter user to Matrix DM room. Creating a new one! gitterUserId=${gitterUserId} gitterRoomId=${gitterRoomId} oldMatrixRoomId=${matrixRoomId}`
        );

        // Sanity check the user that joined the Gitter DM room is the same one from the URL
        assert(mongoUtils.objectIDsEqual(matrixDm.gitterUserId, gitterUserId));

        const gitterUser = await userService.findById(gitterUserId);
        assert(gitterUser);

        let newMatrixRoomId = await this.matrixUtils.createMatrixDmRoomByGitterUserAndOtherPersonMxid(
          gitterUser,
          matrixDm.virtualUserId
        );

        logger.info(
          `Storing new bridged DM room (Gitter gitterRoomId=${gitterRoomId} -> Matrix room_id=${newMatrixRoomId}): ${gitterRoom.lcUri}`
        );
        await store.storeBridgedRoom(gitterRoomId, newMatrixRoomId);
      } else {
        throw err;
      }
    }

    // When someone joins the room, check if they are an admin and add power levels if necessary
    let canAdmin;
    try {
      const gitterUser = await userService.findById(gitterUserId);
      assert(gitterUser);
      const policy = await policyFactory.createPolicyForRoom(gitterUser, gitterRoom);
      canAdmin = await policy.canAdmin();
      if (canAdmin) {
        this.matrixUtils.addAdminToMatrixRoomId({
          mxid: matrixId,
          matrixRoomId
        });
      }
    } catch (err) {
      if (canAdmin) {
        logger.error(
          `User (gitterUserId=${gitterUserId}) joined gitterRoomId=${gitterRoomId} but we failed to add their mxid=${matrixId} as an admin of ${matrixRoomId}. This will result in desynced power-levels in the Matrix room. Hopefully another action will update things.`,
          {
            exception: err
          }
        );
      }

      throw err;
    }
  }

  async handleUserLeavingRoom(gitterRoomId, model) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    const matrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    // Just ignore the bridging leave if the Matrix room hasn't been created yet
    if (!matrixRoomId) {
      return null;
    }

    const gitterUserId = model.id;
    assert(gitterUserId);
    const matrixId = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);
    assert(matrixId);

    const intent = this.matrixBridge.getIntent(matrixId);
    await intent.leave(matrixRoomId);
  }

  async handleRoomBanEvent(gitterRoomId, model, operation) {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(gitterRoomId);
    if (!allowedToBridge) {
      return null;
    }

    const matrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (!matrixRoomId) {
      return null;
    }

    stats.event('gitter_bridge.user_ban', {
      gitterRoomId,
      matrixRoomId,
      operation,
      userId: model.userId,
      virtualUser: model.virtualUser
    });

    let bannedMxid;
    if (model.userId) {
      const gitterUser = await userService.findById(model.userId);
      assert(gitterUser);

      bannedMxid = getMxidForGitterUser(gitterUser);
    } else if (model.virtualUser) {
      bannedMxid = `@${model.virtualUser.externalId}`;
    }
    assert(bannedMxid);

    const bridgeIntent = this.matrixBridge.getIntent();
    if (operation === 'create') {
      logger.info(`Banning ${bannedMxid} from ${matrixRoomId}`);
      await bridgeIntent.ban(matrixRoomId, bannedMxid, 'Banned on Gitter');
    } else if (operation === 'remove') {
      logger.info(`Unbanning ${bannedMxid} from ${matrixRoomId}`);
      await bridgeIntent.unban(matrixRoomId, bannedMxid);
    }
  }

  // This is tested by `test/request-web-tests/matrix-bridging-power-level-tests.js`
  async handleRoomSecurityDescriptorUpdateEvent(gitterRoomId, model) {
    const matrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (!matrixRoomId) {
      return null;
    }

    // A historical room is optional as it might not have been created yet.
    const matrixHistoricalRoomId = await store.getHistoricalMatrixRoomIdByGitterRoomId(
      gitterRoomId
    );

    // Loop through all of the room admins listed in the Matrix power levels and
    // remove any people that don't pass the Gitter admin check.
    await this.matrixUtils.cleanupAdminsInMatrixRoomIdAccordingToGitterRoomId({
      matrixRoomId,
      gitterRoomId
    });
    if (matrixHistoricalRoomId) {
      await this.matrixUtils.cleanupAdminsInMatrixRoomIdAccordingToGitterRoomId({
        matrixRoomId: matrixHistoricalRoomId,
        gitterRoomId
      });
    }

    // If only the `sd.extraAdmins` were updated as part of a "patch", then we know that
    // the only admin changes are in this list so we can shortcut and only run through
    // admins in that list and make sure they have the proper Matrix power levels
    const onlyExtraAdminsUpdated = Object.keys(model) === 1 && model.extraAdmins;

    // Loop through all Gitter admins (smartly) and add power levels for anyone that
    // passes the Gitter admin check.
    await this.matrixUtils.addAdminsInMatrixRoomIdAccordingToGitterRoomId({
      matrixRoomId,
      gitterRoomId,
      useShortcutToOnlyLookThroughExtraAdmins: onlyExtraAdminsUpdated
    });
    if (matrixHistoricalRoomId) {
      await this.matrixUtils.addAdminsInMatrixRoomIdAccordingToGitterRoomId({
        matrixRoomId: matrixHistoricalRoomId,
        gitterRoomId,
        useShortcutToOnlyLookThroughExtraAdmins: onlyExtraAdminsUpdated
      });
    }
  }

  // This is tested by `test/request-web-tests/matrix-bridging-power-level-tests.js`
  async handleGroupSecurityDescriptorUpdateEvent(gitterGroupId /*, model*/) {
    // If only the `sd.extraAdmins` were updated as part of a "patch", then we know that
    // the only admin changes are in this list so we can shortcut and only run through
    // admins in that list and make sure they have the proper Matrix power levels
    //
    // XXX: In the future, it would be cool to factor in this shortcut to the room
    // shortcut. But I've left it out for the sake of reduing complexity atm.
    //
    // const onlyExtraAdminsUpdated = Object.keys(model) === 1 && model.extraAdmins;

    const roomsInGroup = await groupService.findRoomsInGroup(gitterGroupId);

    for (const gitterRoom of roomsInGroup) {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // If the room is inheriting from the group, then we need to update the admins in the room
      const isRoomInheritingFromGroup =
        gitterRoom.sd && gitterRoom.sd.type === 'GROUP' && gitterRoom.sd.admins === 'GROUP_ADMIN';

      if (isRoomInheritingFromGroup) {
        await this.handleRoomSecurityDescriptorUpdateEvent(gitterRoomId, {});
      }
    }
  }
}

module.exports = GitterBridge;
