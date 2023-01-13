'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:matrix-utils');
const assert = require('assert');
const path = require('path');
const urlJoin = require('url-join');
const StatusError = require('statuserror');

const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const groupService = require('gitter-web-groups');
const userService = require('gitter-web-users');
const avatars = require('gitter-web-avatars');
const getRoomNameFromTroupeName = require('gitter-web-shared/get-room-name-from-troupe-name');
const securityDescriptorUtils = require('gitter-web-permissions/lib/security-descriptor-utils');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const {
  getCanonicalAliasLocalpartForGitterRoomUri,
  getCanonicalAliasForGitterRoomUri
} = require('./matrix-alias-utils');
const getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid = require('./get-gitter-dm-room-uri-by-gitter-user-id-and-other-person-mxid');
const getMxidForGitterUser = require('./get-mxid-for-gitter-user');
const downloadFileToBuffer = require('./download-file-to-buffer');
const discoverMatrixDmUri = require('./discover-matrix-dm-uri');

const store = require('./store');

const serverName = config.get('matrix:bridge:serverName');
// The bridge user we are using to interact with everything on the Matrix side
const matrixBridgeMxidLocalpart = config.get('matrix:bridge:matrixBridgeMxidLocalpart');
// The Gitter user we are pulling profile information from to populate the Matrix bridge user profile
const gitterBridgeProfileUsername = config.get('matrix:bridge:gitterBridgeProfileUsername');
const gitterLogoMxc = config.get('matrix:bridge:gitterLogoMxc');

const extraPowerLevelUserList = config.get('matrix:bridge:extraPowerLevelUserList') || [];
// Workaround the fact that we can't have a direct map from MXID to power levels because
// nconf doesn't like when we put colons (`:`) in keys (see
// https://gitlab.com/gitterHQ/env/-/merge_requests/34). So instead we have  list of
// object entries to re-interprete into a object.
const extraPowerLevelUsers = extraPowerLevelUserList.reduce((accumulatedPowerLevelUsers, entry) => {
  const [key, value] = entry;
  accumulatedPowerLevelUsers[key] = value;
  return accumulatedPowerLevelUsers;
}, {});

let txnCount = 0;
function getTxnId() {
  txnCount++;
  return `${new Date().getTime()}--${txnCount}`;
}

class MatrixUtils {
  constructor(matrixBridge) {
    this.matrixBridge = matrixBridge;
  }

  async createMatrixRoomByGitterRoomId(
    gitterRoomId,
    {
      // This option is used when we want to create a room where we can import all history
      // into. We want to leave the current room in place and have a separate room where
      // the history (because we're bound to mess up the import and not be happy later on)
      // will live that we can point to.
      shouldUpdateRoomDirectory = true
    } = {}
  ) {
    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `Unable to create Matrix Room for Gitter room ID that does not exist gitterRoomId=${gitterRoomId}`
    );

    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);

    // Protect from accidentally creating Matrix DM room.
    // We should only be creating a Matrix DM room from `createMatrixDmRoomByGitterUserAndOtherPersonMxid`
    const isMatrixDmRoom = !!discoverMatrixDmUri(gitterRoom.lcUri);
    assert.strictEqual(
      isMatrixDmRoom,
      false,
      `DM rooms with Matrix users can only be created with createMatrixDmRoomByGitterUserAndOtherPersonMxid. gitterRoomId=${gitterRoomId} gitterLcUri=${gitterRoom.lcUri}`
    );

    // Let's handle ONE_TO_ONE rooms in their own way
    if (gitterRoom.sd.type === 'ONE_TO_ONE') {
      return this._createMatrixRoomForOneToOne(gitterRoom);
    }

    const bridgeIntent = this.matrixBridge.getIntent();

    const matrixRoomCreateOptions = {
      name: gitterRoom.uri
    };

    if (shouldUpdateRoomDirectory) {
      // We use this as a locking mechanism.
      //
      // The bridge will return an error: `M_ROOM_IN_USE: Room alias already taken`
      // if another process is already in the working on creating the room
      const roomAliasLocalPart = getCanonicalAliasLocalpartForGitterRoomUri(gitterRoom.uri);
      matrixRoomCreateOptions.room_alias_name = roomAliasLocalPart;
    }

    if (isGitterRoomPublic) {
      matrixRoomCreateOptions.visibility = 'public';
      matrixRoomCreateOptions.preset = 'public_chat';
    } else {
      matrixRoomCreateOptions.visibility = 'private';
      matrixRoomCreateOptions.preset = 'private_chat';
    }

    const newRoom = await bridgeIntent.createRoom({
      createAsClient: true,
      options: matrixRoomCreateOptions
    });

    return newRoom.room_id;
  }

  // This is an internal function used for Gitter ONE_TO_ONE rooms (not to be
  // confused with Matrix DM rooms between a Gitter user and a Matrix user).
  async _createMatrixRoomForOneToOne(gitterRoom) {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;

    assert.strictEqual(
      gitterRoom.sd.type,
      'ONE_TO_ONE',
      `_createMatrixRoomForOneToOne can only be used with ONE_TO_ONE rooms. gitterRoomId=${gitterRoomId}`
    );

    // Sanity check that we're working with a one to one between 2 users as expected
    assert.strictEqual(
      gitterRoom.oneToOneUsers && gitterRoom.oneToOneUsers.length,
      2,
      `ONE_TO_ONE room can only have 2 users in it but found ${gitterRoom.oneToOneUsers &&
        gitterRoom.oneToOneUsers.length}. gitterRoomId=${gitterRoomId}`
    );

    // The room creator can be the first person in the list of users (doesn't matter)
    const gitterUserCreatorMxid = await this.getOrCreateMatrixUserByGitterUserId(
      gitterRoom.oneToOneUsers[0].userId
    );
    const gitterUserOtherMxid = await this.getOrCreateMatrixUserByGitterUserId(
      gitterRoom.oneToOneUsers[1].userId
    );

    const intent = this.matrixBridge.getIntent(gitterUserCreatorMxid);

    const newRoom = await intent.createRoom({
      createAsClient: true,
      options: {
        visibility: 'private',
        // This means all invitees are given the same power level as the room creator.
        preset: 'trusted_private_chat',
        is_direct: true,
        invite: [gitterUserOtherMxid]
      }
    });

    return newRoom.room_id;
  }

  // Used to create bridged DM room between a Gitter user and a Matrix user.
  //
  // This does not store the bridged room that was created because we want to
  // see that the Matrix room was created successfully before creating the
  // Gitter room which is needed to store the bridged connection.
  async createMatrixDmRoomByGitterUserAndOtherPersonMxid(gitterUser, otherPersonMxid) {
    const gitterUserId = gitterUser.id || gitterUser._id;
    const gitterUserMxid = await this.getOrCreateMatrixUserByGitterUserId(gitterUserId);
    const intent = this.matrixBridge.getIntent(gitterUserMxid);

    try {
      // Make sure the user exists
      await intent.getProfileInfo(otherPersonMxid);

      const newRoom = await intent.createRoom({
        createAsClient: true,
        options: {
          visibility: 'private',
          preset: 'trusted_private_chat',
          is_direct: true,
          invite: [otherPersonMxid]
        }
      });

      return newRoom.room_id;
    } catch (err) {
      if (
        err.body &&
        (err.body.errcode === 'M_NOT_FOUND' ||
          err.body.errcode === 'M_UNAUTHORIZED' ||
          err.body.errcode === 'M_UNKNOWN')
      ) {
        throw new StatusError(
          404,
          `Unable to create Matrix DM. MXID does not exist (${otherPersonMxid})`
        );
      }

      throw err;
    }
  }

  async ensureStateEventAsMxid(mxid, matrixRoomId, eventType, newContent) {
    // mxid can be `undefined` to indicate the bridge intent
    assert(matrixRoomId);
    assert(eventType);
    assert(newContent);

    const intent = this.matrixBridge.getIntent(mxid);

    let currentContent;
    try {
      currentContent = await intent.getStateEvent(matrixRoomId, eventType);
    } catch (err) {
      // no-op
    }

    let isContentSame = false;
    try {
      assert.deepEqual(newContent, currentContent);
      isContentSame = true;
    } catch (err) {
      // no-op
    }

    debug(
      `ensureStateEvent(${matrixRoomId}, ${eventType}): isContentSame=${isContentSame} currentContent`,
      currentContent,
      'newContent',
      newContent
    );
    if (!isContentSame) {
      await intent.sendStateEvent(matrixRoomId, eventType, '', newContent);
    }
  }

  async ensureStateEvent(matrixRoomId, eventType, newContent) {
    return this.ensureStateEventAsMxid(
      // undefined will give us the bridgeIntent
      undefined,
      matrixRoomId,
      eventType,
      newContent
    );
  }

  async ensureRoomAlias(matrixRoomId, alias) {
    const bridgeIntent = this.matrixBridge.getIntent();

    let isAliasAlreadySet = false;
    let currentAliasedRoomId;
    try {
      currentAliasedRoomId = await bridgeIntent.matrixClient.resolveRoom(alias);
    } catch (err) {
      // no-op
    }

    if (currentAliasedRoomId === matrixRoomId) {
      isAliasAlreadySet = true;
    } else if (currentAliasedRoomId) {
      // Delete the alias from the other room
      await bridgeIntent.matrixClient.deleteRoomAlias(alias);
    }

    debug(`ensureRoomAlias(${matrixRoomId}, ${alias}) isAliasAlreadySet=${isAliasAlreadySet}`);
    if (!isAliasAlreadySet) {
      await bridgeIntent.createAlias(alias, matrixRoomId);
    }
  }

  async uploadAvatarUrlToMatrix(avatarUrl) {
    // No avatarURL, no problem, just bail early
    if (!avatarUrl) {
      return undefined;
    }

    const bridgeIntent = this.matrixBridge.getIntent();

    let data;
    try {
      data = await downloadFileToBuffer(avatarUrl);
    } catch (err) {
      // Just log an error and noop if the user avatar fails to download.
      // It's more important that we just send their message without the avatar.
      logger.error(
        `Failed to download avatar (avatarUrl=${avatarUrl}) which we were going to use for bridging something in Matrix`,
        {
          exception: err
        }
      );
      return undefined;
    }

    let mxcUrl;
    if (data) {
      try {
        mxcUrl = await bridgeIntent.uploadContent(data.buffer, {
          onlyContentUri: true,
          rawResponse: false,
          name: path.basename(avatarUrl),
          type: data.mimeType
        });
      } catch (err) {
        // Just log an error and noop if the user avatar fails to upload.
        // It's more important that we just send their message without the avatar.
        logger.error(
          `Failed to upload avatar (avatarUrl=${avatarUrl}) which we were going to use for bridging something in Matrix`,
          {
            exception: err
          }
        );
        return undefined;
      }
    }

    return mxcUrl;
  }

  async ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom) {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;

    // Set the human-readable room aliases
    const roomAlias = getCanonicalAliasForGitterRoomUri(gitterRoom.uri);
    await this.ensureRoomAlias(matrixRoomId, roomAlias);
    // Add another alias for the room ID
    await this.ensureRoomAlias(matrixRoomId, `#${gitterRoomId}:${serverName}`);
    // Add a lowercase alias if necessary
    if (roomAlias.toLowerCase() !== roomAlias) {
      await this.ensureRoomAlias(matrixRoomId, roomAlias.toLowerCase());
    }
  }

  // eslint-disable-next-line max-statements
  async ensureCorrectRoomState(
    matrixRoomId,
    gitterRoomId,
    {
      // We have some snowflake Matrix room permissions setup for some particular
      // communities to be able to self-manage and moderate. Avoid regressing them back
      // to defaults.
      keepExistingUserPowerLevels = true,
      // This option is used when we want to create a room where we can import all history
      // into. We want to leave the current room in place and have a separate room where
      // the history (because we're bound to mess up the import and not be happy later on)
      // will live that we can point to.
      shouldUpdateRoomDirectory = true,
      // People should be able to chat in rooms by default. We only use this for historical Matrix rooms
      readOnly = false
    } = {}
  ) {
    const gitterRoom = await troupeService.findById(gitterRoomId);
    const gitterGroup = await groupService.findById(gitterRoom.groupId);

    // Protect from accidentally running this on a ONE_TO_ONE room.
    assert.notStrictEqual(
      gitterRoom.sd.type,
      'ONE_TO_ONE',
      `ensureCorrectRoomState should not be used on ONE_TO_ONE rooms. gitterRoomId=${gitterRoomId}`
    );

    assert(
      gitterGroup,
      `groupId=${gitterRoom.groupId} unexpectedly does not exist for gitterRoomId=${gitterRoomId}`
    );

    // Protect from accidentally running this on a Matrix DM room.
    const isMatrixDmRoom = !!discoverMatrixDmUri(gitterRoom.lcUri);
    assert.strictEqual(
      isMatrixDmRoom,
      false,
      `ensureCorrectRoomState should not be sued on DM rooms with Matrix users. gitterRoomId=${gitterRoomId}`
    );

    const bridgeIntent = this.matrixBridge.getIntent();

    if (shouldUpdateRoomDirectory) {
      // Set the aliases first because we can always change our own `#*:gitter.im`
      // namespaced aliases but we will not always be able to control the room itself to
      // update the name/topic, etc
      await this.ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom);
    }

    await this.ensureStateEvent(matrixRoomId, 'm.room.name', {
      name: gitterRoom.uri
    });
    await this.ensureStateEvent(matrixRoomId, 'm.room.topic', {
      topic: gitterRoom.topic
    });
    // We don't have to gate this off behind `shouldUpdateRoomDirectory` because this
    // won't change the room directory at all. This is just used as a hint for how
    // clients will display this room after it is tombstoned.
    //
    // This currently doesn't work because of `Error: M_BAD_ALIAS: Room alias
    // #xxx:server does not point to the room`. TODO: Update Synapse not to be so strict
    // as multiple rooms have `m.room.canonical_alias` all the time with room upgrades
    // const roomAlias = getCanonicalAliasForGitterRoomUri(gitterRoom.uri); await
    // this.ensureStateEvent(matrixRoomId, 'm.room.canonical_alias', { alias: roomAlias
    // });

    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);

    const roomDirectoryVisibility = await bridgeIntent.matrixClient.getDirectoryVisibility(
      matrixRoomId
    );
    if (isGitterRoomPublic) {
      if (shouldUpdateRoomDirectory && roomDirectoryVisibility !== 'public') {
        await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'public');
      }
      await this.ensureStateEvent(matrixRoomId, 'm.room.history_visibility', {
        history_visibility: 'world_readable'
      });
      await this.ensureStateEvent(matrixRoomId, 'm.room.join_rules', {
        join_rule: 'public'
      });
    }
    // Private
    else {
      if (shouldUpdateRoomDirectory && roomDirectoryVisibility !== 'private') {
        await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');
      }
      await this.ensureStateEvent(matrixRoomId, 'm.room.history_visibility', {
        history_visibility: 'shared'
      });
      await this.ensureStateEvent(matrixRoomId, 'm.room.join_rules', {
        join_rule: 'invite'
      });
    }

    // We have some snowflake Matrix room permissions setup for some particular
    // communities to be able to self-manage and moderate. Avoid regressing them back
    // to defaults.
    let existingUserPowerLevels = {};
    if (keepExistingUserPowerLevels) {
      let currentPowerLevelContent;
      try {
        currentPowerLevelContent = await bridgeIntent.getStateEvent(
          matrixRoomId,
          'm.room.power_levels'
        );
        existingUserPowerLevels = currentPowerLevelContent.users;
      } catch (err) {
        // no-op
      }
    }

    const bridgeMxid = this.getMxidForMatrixBridgeUser();
    // https://matrix.org/docs/spec/client_server/r0.2.0#m-room-power-levels
    await this.ensureStateEvent(matrixRoomId, 'm.room.power_levels', {
      users_default: 0,
      users: {
        ...existingUserPowerLevels,
        ...extraPowerLevelUsers,
        [bridgeMxid]: 100
      },
      events: {
        'm.room.avatar': 50,
        'm.room.canonical_alias': 50,
        'm.room.encryption': 100,
        'm.room.history_visibility': 100,
        'm.room.name': 50,
        'm.room.power_levels': 100,
        'm.room.server_acl': 100,
        'm.room.tombstone': 100
      },
      events_default: readOnly ? 50 : 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0
    });

    // TODO: Ensure historical predecessor set correctly. This function is also used for
    // historical rooms so be mindful

    // Set the room avatar
    const roomAvatarUrl = avatars.getForGroupId(gitterRoom.groupId);
    const roomMxcUrl = await this.uploadAvatarUrlToMatrix(roomAvatarUrl);
    if (roomMxcUrl) {
      await this.ensureStateEvent(matrixRoomId, 'm.room.avatar', {
        url: roomMxcUrl
      });
    }

    // Add some meta info to cross-link and show that the Matrix room is bridged over to Gitter
    await this.ensureStateEvent(matrixRoomId, 'uk.half-shot.bridge', {
      bridgebot: this.getMxidForMatrixBridgeUser(),
      protocol: {
        id: 'gitter',
        displayname: 'Gitter',
        avatar_url: gitterLogoMxc,
        external_url: 'https://gitter.im/'
      },
      channel: {
        id: gitterRoom.id,
        displayname: `${gitterGroup.name}/${getRoomNameFromTroupeName(gitterRoom.uri)}`,
        avatar_url: roomMxcUrl,
        external_url: urlJoin(config.get('web:basepath'), gitterRoom.uri)
      }
    });
  }

  // Will make the historical Matrix room read-only and tombstone the room to point at
  // the current one.
  //
  // The reason we don't run this when the room is created is because we need
  // power-levels for the bridge to import and be able to send messages as all of the
  // `gitter.im` homeserver users. And we only want to send the tombstone event at the
  // end after all of the history for maximum semantics (history continues after this
  // point at the end).
  async ensureCorrectHistoricalMatrixRoomStateAfterImport({
    // The current live room
    matrixRoomId,
    // The historical room to ensure correct state in
    matrixHistoricalRoomId,
    gitterRoomId
  }) {
    assert(matrixRoomId);
    assert(matrixHistoricalRoomId);
    assert(gitterRoomId);
    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `ensureCorrectHistoricalMatrixRoomStateAfterImport: gitterRoomId=${gitterRoomId} does not exist`
    );

    // One to one rooms are setup correctly from the beginning and never need updates
    if (gitterRoom.sd.type !== 'ONE_TO_ONE') {
      // Propagate all of the room details over to Matrix like the room topic and avatar
      await this.ensureCorrectRoomState(matrixHistoricalRoomId, gitterRoomId, {
        // We don't want this historical room to show up in the room directory. It will
        // only be pointed back to by the current room in its predecessor.
        shouldUpdateRoomDirectory: false,
        // Make the room read-only so no one can mess up the history
        readOnly: true
      });
    }

    if (gitterRoom.sd.type === 'ONE_TO_ONE') {
      // Since the bridge user isn't in ONE_TO_ONE rooms, let's use the one of the
      // people in the ONE_TO_ONE room. The room creator can be the first person in the
      // list of users (doesn't matter).
      const gitterUserCreatorMxid = await this.getOrCreateMatrixUserByGitterUserId(
        gitterRoom.oneToOneUsers[0].userId
      );

      // Ensure tombstone event pointing to the main live room
      await this.ensureStateEventAsMxid(
        gitterUserCreatorMxid,
        matrixHistoricalRoomId,
        'm.room.tombstone',
        {
          replacement_room: matrixRoomId
        }
      );
    } else {
      // Ensure tombstone event pointing to the main live room
      await this.ensureStateEvent(matrixHistoricalRoomId, 'm.room.tombstone', {
        replacement_room: matrixRoomId
      });
    }
  }

  async deleteRoomAliasesForMatrixRoomId(matrixRoomId) {
    const bridgeIntent = this.matrixBridge.getIntent();

    const roomAliases = await bridgeIntent.matrixClient.unstableApis.getRoomAliases(matrixRoomId);
    if (roomAliases) {
      for (const roomAlias of roomAliases) {
        // Delete the alias from the other room
        await bridgeIntent.matrixClient.deleteRoomAlias(roomAlias);
      }
    }
  }

  // eslint-disable-next-line max-statements
  async shutdownMatrixRoom(matrixRoomId, { forceRemoveIfNoGitterRoom = false } = {}) {
    assert(matrixRoomId, `matrixRoomId required to shutdownMatrixRoom`);

    let gitterRoomId = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
    // If we can't find it from the normal one, try to find it in the historical rooms
    if (!gitterRoomId) {
      gitterRoomId = await store.getGitterRoomIdByHistoricalMatrixRoomId(matrixRoomId);
    }

    // If we can find the Gitter room, no problem. Otherwise, only skip this if
    // `forceRemoveIfNoGitterRoom=true`. This block of code will clean up ONE_TO_ONE
    // rooms properly.
    const gitterRoom = gitterRoomId && (await troupeService.findByIdLean(gitterRoomId));
    if (gitterRoom || !forceRemoveIfNoGitterRoom) {
      assert(
        gitterRoom,
        `Unable to find gitterRoomId=${gitterRoomId} for matrixRoomId=${matrixRoomId} and forceRemoveIfNoGitterRoom=${forceRemoveIfNoGitterRoom} so we can't skip this check`
      );

      if (gitterRoom.oneToOne) {
        debug(
          `shutdownMatrixRoom(${matrixRoomId}): Making both parties leave the room since this is a ONE_TO_ONE room`
        );
        const gitterUserCreatorMxid = await this.getOrCreateMatrixUserByGitterUserId(
          gitterRoom.oneToOneUsers[0].userId
        );
        const gitterUserOtherMxid = await this.getOrCreateMatrixUserByGitterUserId(
          gitterRoom.oneToOneUsers[1].userId
        );

        const userCreatorIntent = this.matrixBridge.getIntent(gitterUserCreatorMxid);
        const userOtherIntent = this.matrixBridge.getIntent(gitterUserOtherMxid);

        await userCreatorIntent.leave(matrixRoomId);
        await userOtherIntent.leave(matrixRoomId);

        return;
      }
    }

    // For normal public/private rooms where the bridge user is an admin
    // ==================================================================

    // Delete aliases
    debug(`shutdownMatrixRoom(${matrixRoomId}): Deleting room aliases`);
    await this.deleteRoomAliasesForMatrixRoomId(matrixRoomId);

    // Change history visiblity so future people can't read the room
    debug(
      `shutdownMatrixRoom(${matrixRoomId}): Changing history visibility so the history isn't visible if anyone is able to join again`
    );
    await this.ensureStateEvent(matrixRoomId, 'm.room.history_visibility', {
      history_visibility: 'joined'
    });

    const bridgeIntent = this.matrixBridge.getIntent();

    // Remove it from the room directory
    debug(`shutdownMatrixRoom(${matrixRoomId}): Removing room from directory`);
    await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');

    // Make it so people can't join back in
    debug(
      `shutdownMatrixRoom(${matrixRoomId}): Changing the join_rules to invite-only so people can't join back`
    );
    await this.ensureStateEvent(matrixRoomId, 'm.room.join_rules', {
      join_rule: 'invite'
    });

    // Kick everyone out
    debug(`shutdownMatrixRoom(${matrixRoomId}): Kicking everyone out of the room`);
    const roomMembers = await bridgeIntent.matrixClient.getRoomMembers(matrixRoomId, null, [
      'join'
    ]);
    debug(
      `shutdownMatrixRoom(${matrixRoomId}): Kicking ${roomMembers && roomMembers.length} people`
    );
    if (roomMembers) {
      for (let roomMember of roomMembers) {
        // Kick everyone except the main bridge user
        if (roomMember.membershipFor !== this.getMxidForMatrixBridgeUser()) {
          debug(`\tshutdownMatrixRoom(${matrixRoomId}): Kicking ${roomMember.membershipFor}`);
          await bridgeIntent.kick(matrixRoomId, roomMember.membershipFor);
        }
      }
    }
  }

  async getOrCreateMatrixRoomByGitterRoomId(gitterRoomId) {
    // Find the cached existing bridged room
    const existingMatrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (existingMatrixRoomId) {
      return existingMatrixRoomId;
    }

    // Create the Matrix room since one doesn't already exist
    logger.info(
      `Existing Matrix room not found, creating new Matrix room for roomId=${gitterRoomId}`
    );

    const matrixRoomId = await this.createMatrixRoomByGitterRoomId(gitterRoomId);
    // Store the bridged room right away!
    // If we created a bridged room, we want to make sure we store it 100% of the time
    logger.info(
      `Storing bridged room (Gitter room id=${gitterRoomId} -> Matrix room_id=${matrixRoomId})`
    );
    await store.storeBridgedRoom(gitterRoomId, matrixRoomId);

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `gitterRoomId=${gitterRoomId} unexpectedly does not exist after we just created a Matrix room for it. We are unable to determine whether we need to ensureCorrectRoomState for it.`
    );
    if (gitterRoom.sd.type !== 'ONE_TO_ONE') {
      // Propagate all of the room details over to Matrix like the room topic and avatar
      await this.ensureCorrectRoomState(matrixRoomId, gitterRoomId);
    }

    return matrixRoomId;
  }

  async getOrCreateHistoricalMatrixRoomByGitterRoomId(gitterRoomId) {
    // Find the cached existing bridged room
    const existingMatrixRoomId = await store.getHistoricalMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (existingMatrixRoomId) {
      return existingMatrixRoomId;
    }

    // Create the Matrix room since one doesn't already exist
    logger.info(
      `Existing historical Matrix room not found, creating new historical Matrix room for roomId=${gitterRoomId}`
    );

    const matrixRoomId = await this.createMatrixRoomByGitterRoomId(gitterRoomId, {
      // We don't want this historical room to show up in the room directory. It will
      // only be pointed back to by the current room in its predecessor.
      shouldUpdateRoomDirectory: false
    });
    // Store the bridged room right away!
    // If we created a bridged room, we want to make sure we store it 100% of the time
    logger.info(
      `Storing bridged historical room (Gitter room id=${gitterRoomId} -> Matrix room_id=${matrixRoomId})`
    );
    await store.storeBridgedHistoricalRoom(gitterRoomId, matrixRoomId);

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `ensureCorrectRoomStateForHistoricalMatrixRoom: gitterRoomId=${gitterRoomId} unexpectedly does not exist after we just created a Matrix room for it. We are unable to determine whether we need to ensureCorrectRoomState for it.`
    );

    // One to one rooms are setup correctly from the beginning and never need updates
    if (gitterRoom.sd.type !== 'ONE_TO_ONE') {
      // Propagate all of the room details over to Matrix like the room topic and avatar
      await this.ensureCorrectRoomState(matrixRoomId, gitterRoomId, {
        // We don't want this historical room to show up in the room directory. It will
        // only be pointed back to by the current room in its predecessor.
        shouldUpdateRoomDirectory: false,
        // In the end, we want to make the room read-only so no one can mess up the
        // history. But we leave it so people can send messages in the room for now so
        // we can import everything first.
        //
        // XXX: It's important to call
        // `ensureCorrectHistoricalMatrixRoomStateAfterImport` after you're done
        // importing! The reason we don't call
        // `ensureCorrectHistoricalMatrixRoomStateAfterImport` here when the room is
        // created is because we need power-levels for the bridge to import and be able
        // to send messages as all of the `gitter.im` homeserver users. And we only want
        // to send the tombstone event at the end after all of the history for maximum
        // semantics (history continues after this point at the end).
        readOnly: false
      });
    }

    return matrixRoomId;
  }

  async getOrCreateMatrixDmRoomByGitterUserAndOtherPersonMxid(gitterUser, otherPersonMxid) {
    // Find the cached existing bridged room
    const gitterUserId = gitterUser.id || gitterUser._id;
    const gitterDmRoom = await troupeService.findByUri(
      getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid)
    );
    const gitterRoomId = gitterDmRoom.id;
    const existingMatrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (existingMatrixRoomId) {
      return existingMatrixRoomId;
    }

    // Create the Matrix room if it doesn't already exist
    logger.info(
      `Existing Matrix room not found, creating new Matrix DM room for between gitterUser=${gitterUserId} (${gitterUser.username}) otherPersonMxid=${otherPersonMxid}`
    );

    const matrixRoomId = await this.createMatrixDmRoomByGitterUserAndOtherPersonMxid(
      gitterUser,
      otherPersonMxid
    );

    return matrixRoomId;
  }

  async ensureCorrectMxidProfile(mxid, gitterUserId) {
    assert(mxid, 'mxid required');
    assert(gitterUserId, 'gitterUserId required');
    const gitterUser = await userService.findById(gitterUserId);
    assert(gitterUser, `gitterUser not found (${gitterUserId})`);

    const intent = this.matrixBridge.getIntent(mxid);

    let currentProfile = {};
    try {
      currentProfile = await intent.getProfileInfo(mxid, null);
    } catch (err) {
      // no-op
    }

    const desiredDisplayName = `${gitterUser.username} (${gitterUser.displayName})`;
    if (desiredDisplayName !== currentProfile.displayname) {
      await intent.setDisplayName(desiredDisplayName);
    }

    const gitterAvatarUrl = avatars.getForUser(gitterUser);
    const mxcUrl = await this.uploadAvatarUrlToMatrix(gitterAvatarUrl);
    if (mxcUrl !== currentProfile.avatar_url) {
      if (mxcUrl) {
        await intent.setAvatarUrl(mxcUrl);
      } else {
        // Workaround the fact there isn't an official way to reset the avatar,
        // see https://github.com/matrix-org/matrix-spec/issues/378.
        //
        // An empty string is what Element Web does to reset things. If we left this as
        // `undefined`, it would throw `M_MISSING_PARAM: Missing key 'avatar_url'`
        await intent.setAvatarUrl('');
      }
    }
  }

  async getOrCreateMatrixUserByGitterUserId(gitterUserId) {
    const existingMatrixUserId = await store.getMatrixUserIdByGitterUserId(gitterUserId);
    if (existingMatrixUserId) {
      return existingMatrixUserId;
    }

    const gitterUser = await userService.findById(gitterUserId);
    if (!gitterUser) {
      throw new Error(
        `Unable to get or create Matrix user because we were unable to find a Gitter user with gitterUserId=${gitterUserId}`
      );
    }
    const mxid = getMxidForGitterUser(gitterUser);
    await this.ensureCorrectMxidProfile(mxid, gitterUserId);

    try {
      logger.info(`Storing bridged user (Gitter user id=${gitterUser.id} -> Matrix mxid=${mxid})`);
      await store.storeBridgedUser(gitterUser.id, mxid);
    } catch (err) {
      // If we see a `E11000 duplicate key error`, then we know we raced someone else to
      // create and store user. Since the user is all created now, we can just safely
      // return the MXID we were trying to create and store in the first place.
      if (mongoUtils.mongoErrorWithCode(11000)(err)) {
        return mxid;
      }

      throw err;
    }

    return mxid;
  }

  getMxidForMatrixBridgeUser() {
    const mxid = `@${matrixBridgeMxidLocalpart}:${serverName}`;
    return mxid;
  }

  // Ensures the bridge bot user is registered and updates its profile info.
  async ensureCorrectMatrixBridgeUserProfile() {
    const mxid = this.getMxidForMatrixBridgeUser();
    logger.info(`Ensuring profile info is up-to-date for the Matrix bridge user mxid=${mxid}`);

    const bridgeIntent = this.matrixBridge.getIntent();

    await bridgeIntent.ensureRegistered(true);

    const gitterUser = await userService.findByUsername(gitterBridgeProfileUsername);
    await this.ensureCorrectMxidProfile(mxid, gitterUser.id);
  }

  async sendEventAtTimestmap({ type, matrixRoomId, mxid, matrixContent, timestamp }) {
    assert(type);
    assert(matrixRoomId);
    assert(mxid);
    assert(matrixContent);
    assert(timestamp);

    const _sendEventWrapper = async () => {
      const homeserverUrl = this.matrixBridge.opts.homeserverUrl;
      assert(homeserverUrl);
      const asToken = this.matrixBridge.registration.getAppServiceToken();
      assert(asToken);

      const sendEndpoint = `${homeserverUrl}/_matrix/client/r0/rooms/${matrixRoomId}/send/${type}/${getTxnId()}?user_id=${mxid}&ts=${timestamp}`;
      const res = await request({
        method: 'PUT',
        uri: sendEndpoint,
        json: true,
        headers: {
          Authorization: `Bearer ${asToken}`,
          'Content-Type': 'application/json'
        },
        body: matrixContent
      });

      if (res.statusCode !== 200) {
        throw new StatusError(
          res.statusCode,
          `sendEventAtTimestmap({ matrixRoomId: ${matrixRoomId} }) failed ${
            res.statusCode
          }: ${JSON.stringify(res.body)}`
        );
      }

      const eventId = res.body.event_id;
      assert(
        eventId,
        `The request made in sendEventAtTimestmap (${sendEndpoint}) did not return \`event_id\` as expected. ` +
          `This is probably a problem with that homeserver.`
      );

      return eventId;
    };

    let eventId;
    try {
      // Try the happy-path first and assume we're joined to the room
      eventId = await _sendEventWrapper();
    } catch (err) {
      // If we get a 403 forbidden indicating we're not in the room yet, let's try to join
      if (err.status === 403) {
        const intent = this.matrixBridge.getIntent(mxid);
        await intent._ensureJoined(matrixRoomId);
      } else {
        // We don't know how to recover from an arbitrary error that isn't about joining
        throw err;
      }

      // Now that we're joined, try again
      eventId = await _sendEventWrapper();
    }

    return eventId;
  }

  async getMessages({ matrixRoomId, mxid, from, to, dir, limit }) {
    assert(matrixRoomId);
    assert(mxid);
    const _getMessagesWrapper = async () => {
      const homeserverUrl = this.matrixBridge.opts.homeserverUrl;
      assert(homeserverUrl);
      const asToken = this.matrixBridge.registration.getAppServiceToken();
      assert(asToken);

      let qs = new URLSearchParams();
      qs.append('user_id', mxid);
      if (from) {
        qs.append('from', from);
      }
      if (to) {
        qs.append('to', to);
      }
      if (dir) {
        qs.append('dir', dir);
      }
      if (limit) {
        qs.append('limit', limit);
      }

      const messagesEndpoint = `${homeserverUrl}/_matrix/client/r0/rooms/${matrixRoomId}/messages?${qs.toString()}`;
      const res = await request({
        method: 'GET',
        uri: messagesEndpoint,
        json: true,
        headers: {
          Authorization: `Bearer ${asToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (res.statusCode !== 200) {
        throw new StatusError(
          res.statusCode,
          `sendEventAtTimestmap({ matrixRoomId: ${matrixRoomId} }) failed ${
            res.statusCode
          }: ${JSON.stringify(res.body)}`
        );
      }

      return res;
    };

    let res;
    try {
      // Try the happy-path first and assume we're joined to the room
      res = await _getMessagesWrapper();
    } catch (err) {
      // If we get a 403 forbidden indicating we're not in the room yet, let's try to join
      if (err.status === 403) {
        const intent = this.matrixBridge.getIntent(mxid);
        await intent._ensureJoined(matrixRoomId);
      } else {
        // We don't know how to recover from an arbitrary error that isn't about joining
        throw err;
      }

      // Now that we're joined, try again
      res = await _getMessagesWrapper();
    }

    return res.body;
  }
}

module.exports = MatrixUtils;
