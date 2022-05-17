'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:matrix-utils');
const assert = require('assert');
const path = require('path');
const urlJoin = require('url-join');
const StatusError = require('statuserror');
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

class MatrixUtils {
  constructor(matrixBridge) {
    this.matrixBridge = matrixBridge;
  }

  async createMatrixRoomByGitterRoomId(gitterRoomId) {
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

    const roomAlias = getCanonicalAliasLocalpartForGitterRoomUri(gitterRoom.uri);

    const bridgeIntent = this.matrixBridge.getIntent();

    const matrixRoomCreateOptions = {
      name: gitterRoom.uri,
      // We use this as a locking mechanism.
      // The bridge will return an error: `M_ROOM_IN_USE: Room alias already taken`
      // if another process is already in the working on creating the room
      room_alias_name: roomAlias
    };
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
    // Store the bridged room right away!
    // If we created a bridged room, we want to make sure we store it 100% of the time
    logger.info(
      `Storing bridged room (Gitter room id=${gitterRoomId} -> Matrix room_id=${newRoom.room_id})`
    );
    await store.storeBridgedRoom(gitterRoomId, newRoom.room_id);

    // Propagate all of the room details over to Matrix like the room topic and avatar
    await this.ensureCorrectRoomState(newRoom.room_id, gitterRoomId);

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

    // Store the bridged room right away!
    // If we created a bridged room, we want to make sure we store it 100% of the time
    logger.info(
      `Storing bridged ONE_TO_ONE room (Gitter room id=${gitterRoomId} -> Matrix room_id=${newRoom.room_id})`
    );
    await store.storeBridgedRoom(gitterRoomId, newRoom.room_id);

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

  async ensureStateEvent(matrixRoomId, eventType, newContent) {
    const bridgeIntent = this.matrixBridge.getIntent();

    let currentContent;
    try {
      currentContent = await bridgeIntent.getStateEvent(matrixRoomId, eventType);
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
      await bridgeIntent.sendStateEvent(matrixRoomId, eventType, '', newContent);
    }
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
    const bridgeIntent = this.matrixBridge.getIntent();

    let mxcUrl;
    try {
      if (avatarUrl) {
        const data = await downloadFileToBuffer(avatarUrl);
        mxcUrl = await bridgeIntent.uploadContent(data.buffer, {
          onlyContentUri: true,
          rawResponse: false,
          name: path.basename(avatarUrl),
          type: data.mimeType
        });
      }
    } catch (err) {
      // Just log an error and noop if the user avatar fails to download.
      // It's more important that we just send their message without the avatar.
      logger.error(
        `Failed to download avatar (avatarUrl=${avatarUrl}) which we were going to use for bridging something in Matrix`,
        {
          exception: err
        }
      );
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

  async ensureCorrectRoomState(matrixRoomId, gitterRoomId) {
    const gitterRoom = await troupeService.findById(gitterRoomId);
    const gitterGroup = await groupService.findById(gitterRoom.groupId);

    // Protect from accidentally running this on a ONE_TO_ONE room.
    assert.notStrictEqual(
      gitterRoom.sd.type,
      'ONE_TO_ONE',
      `ensureCorrectRoomState should not be used on ONE_TO_ONE rooms. gitterRoomId=${gitterRoomId}`
    );

    // Protect from accidentally running this on a Matrix DM room.
    const isMatrixDmRoom = !!discoverMatrixDmUri(gitterRoom.lcUri);
    assert.strictEqual(
      isMatrixDmRoom,
      false,
      `ensureCorrectRoomState should not be sued on DM rooms with Matrix users. gitterRoomId=${gitterRoomId}`
    );

    const bridgeIntent = this.matrixBridge.getIntent();

    // Set the aliases first because we can always change our own aliases
    // But not be able to control the room itself to update the name/topic, etc
    await this.ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom);

    await this.ensureStateEvent(matrixRoomId, 'm.room.name', {
      name: gitterRoom.uri
    });
    await this.ensureStateEvent(matrixRoomId, 'm.room.topic', {
      topic: gitterRoom.topic
    });

    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);

    const roomDirectoryVisibility = await bridgeIntent.matrixClient.getDirectoryVisibility(
      matrixRoomId
    );
    if (isGitterRoomPublic) {
      if (roomDirectoryVisibility !== 'public') {
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
      if (roomDirectoryVisibility !== 'private') {
        await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');
      }
      await this.ensureStateEvent(matrixRoomId, 'm.room.history_visibility', {
        history_visibility: 'shared'
      });
      await this.ensureStateEvent(matrixRoomId, 'm.room.join_rules', {
        join_rule: 'invite'
      });
    }

    const bridgeMxid = this.getMxidForMatrixBridgeUser();
    // https://matrix.org/docs/spec/client_server/r0.2.0#m-room-power-levels
    await this.ensureStateEvent(matrixRoomId, 'm.room.power_levels', {
      users_default: 0,
      users: {
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
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0
    });

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

  async shutdownMatrixRoom(matrixRoomId) {
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

    // Create the Matrix room if it doesn't already exist
    logger.info(
      `Existing Matrix room not found, creating new Matrix room for roomId=${gitterRoomId}`
    );

    const matrixRoomId = await this.createMatrixRoomByGitterRoomId(gitterRoomId);

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
      await intent.setAvatarUrl(mxcUrl);
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
        `Unable to get or create Gitter user because we were unable to find a Gitter user with gitterUserId=${gitterUserId}`
      );
    }
    const mxid = getMxidForGitterUser(gitterUser);
    await this.ensureCorrectMxidProfile(mxid, gitterUserId);

    logger.info(`Storing bridged user (Gitter user id=${gitterUser.id} -> Matrix mxid=${mxid})`);
    await store.storeBridgedUser(gitterUser.id, mxid);

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
    // TODO: Uncomment before merging
    //await this.ensureCorrectMxidProfile(mxid, gitterUser.id);
  }
}

module.exports = MatrixUtils;
