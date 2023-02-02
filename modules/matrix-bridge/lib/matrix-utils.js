'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:matrix-utils');
const assert = require('assert');
const path = require('path');
const urlJoin = require('url-join');
const StatusError = require('statuserror');

const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const userService = require('gitter-web-users');
const avatars = require('gitter-web-avatars');
const getRoomNameFromTroupeName = require('gitter-web-shared/get-room-name-from-troupe-name');
const securityDescriptorUtils = require('gitter-web-permissions/lib/security-descriptor-utils');
const policyFactory = require('gitter-web-permissions/lib/policy-factory');
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
const parseGitterMxid = require('./parse-gitter-mxid');
const { BRIDGE_USER_POWER_LEVEL, ROOM_ADMIN_POWER_LEVEL } = require('./constants');
const extraPowerLevelUsers = require('./extra-power-level-users-from-config');

const store = require('./store');

const DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP = 100;

const configuredServerName = config.get('matrix:bridge:serverName');
// The bridge user we are using to interact with everything on the Matrix side
const matrixBridgeMxidLocalpart = config.get('matrix:bridge:matrixBridgeMxidLocalpart');
// The Gitter user we are pulling profile information from to populate the Matrix bridge user profile
const gitterBridgeProfileUsername = config.get('matrix:bridge:gitterBridgeProfileUsername');
const gitterLogoMxc = config.get('matrix:bridge:gitterLogoMxc');

const GITLAB_SD_TYPES = [
  'GL_GROUP', // Associated with GitLab group
  'GL_PROJECT', // Associated with GitLab project
  'GL_USER' // Associated with GitLab user
];
const GITHUB_SD_TYPES = [
  'GH_REPO', // Associated with a GitHub repo
  'GH_ORG', // Associated with a GitHub org
  'GH_USER' // Associated with a GitHub user
];

const SD_TYPES_WITH_EXTERNAL_ASSOCIATION = [...GITLAB_SD_TYPES, ...GITHUB_SD_TYPES];

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
      shouldBeInRoomDirectory = true
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

    if (shouldBeInRoomDirectory) {
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

    debug(
      `createMatrixRoomByGitterRoomId(${gitterRoomId}) attempting room creation`,
      matrixRoomCreateOptions
    );
    const newMatrixRoom = await bridgeIntent.createRoom({
      createAsClient: true,
      options: matrixRoomCreateOptions
    });
    const matrixRoomId = newMatrixRoom.room_id;
    debug(`createMatrixRoomByGitterRoomId(${gitterRoomId}) matrixRoomId=${matrixRoomId} created`);

    return matrixRoomId;
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

  async ensureStateEventAsMxid({ mxid, matrixRoomId, eventType, stateKey = '', newContent }) {
    // mxid can be `undefined` to indicate the bridge intent
    assert(matrixRoomId);
    assert(eventType);
    assert(stateKey !== null && stateKey !== undefined);
    assert(newContent);

    const intent = this.matrixBridge.getIntent(mxid);

    let currentContent;
    try {
      currentContent = await intent.getStateEvent(matrixRoomId, eventType, stateKey);
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
      `ensureStateEventAsMxid(${mxid}, ${matrixRoomId}, ${eventType}): isContentSame=${isContentSame} currentContent`,
      currentContent,
      'newContent',
      newContent
    );
    if (!isContentSame) {
      await intent.sendStateEvent(matrixRoomId, eventType, stateKey, newContent);
    }
  }

  async ensureStateEvent({ matrixRoomId, eventType, stateKey = '', newContent }) {
    return this.ensureStateEventAsMxid({
      // undefined will give us the bridgeIntent
      mxid: undefined,
      matrixRoomId,
      eventType,
      stateKey,
      newContent
    });
  }

  async addAdminToMatrixRoomId({ mxid, matrixRoomId }) {
    assert(mxid.startsWith('@'));
    assert(matrixRoomId.startsWith('!'));

    const bridgeIntent = this.matrixBridge.getIntent();
    const currentPowerLevelContent = await bridgeIntent.getStateEvent(
      matrixRoomId,
      'm.room.power_levels'
    );

    // We can bail early if the mxid in question is already in the power levels as an admin
    if ((currentPowerLevelContent.users || {})[mxid] === ROOM_ADMIN_POWER_LEVEL) {
      return;
    }

    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.power_levels',
      newContent: {
        ...currentPowerLevelContent,
        users: {
          ...(currentPowerLevelContent.users || {}),
          [mxid]: ROOM_ADMIN_POWER_LEVEL
        }
      }
    });
  }

  async removeAdminFromMatrixRoomId({ mxid, matrixRoomId }) {
    assert(mxid.startsWith('@'));
    assert(matrixRoomId.startsWith('!'));

    const bridgeIntent = this.matrixBridge.getIntent();
    const currentPowerLevelContent = await bridgeIntent.getStateEvent(
      matrixRoomId,
      'm.room.power_levels'
    );

    // We can bail early in the mxid in question is already not in the power levels
    if ((currentPowerLevelContent.users || {})[mxid] === undefined) {
      return;
    }

    // Copy the power level users map
    const newPowerLevelUsersMap = {
      ...(currentPowerLevelContent.users || {})
    };
    // Then delete the person that should no longer be an admin
    delete newPowerLevelUsersMap[mxid];

    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.power_levels',
      newContent: {
        ...currentPowerLevelContent,
        users: newPowerLevelUsersMap
      }
    });
  }

  // Loop through all of the room admins listed in the Matrix power levels and
  // remove any people that don't pass the Gitter admin check.
  async cleanupAdminsInMatrixRoomIdAccordingToGitterRoomId({ matrixRoomId, gitterRoomId }) {
    assert(gitterRoomId);
    assert(matrixRoomId);

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(gitterRoom);

    const bridgeIntent = this.matrixBridge.getIntent();
    const currentPowerLevelContent = await bridgeIntent.getStateEvent(
      matrixRoomId,
      'm.room.power_levels'
    );
    const powerLevelUserMap = (currentPowerLevelContent && currentPowerLevelContent.users) || {};

    for (const mxid of Object.keys(powerLevelUserMap)) {
      // Skip any MXID's that aren't from our own server (gitter.im)
      const { serverName } = parseGitterMxid(mxid) || {};
      if (serverName !== configuredServerName) {
        continue;
      }

      const currentPowerLevelOfMxid = currentPowerLevelContent.users[mxid];
      // If the user is listed as an admin in the Matrix room power levels,
      // check to make sure they should still be an admin
      if (currentPowerLevelOfMxid === ROOM_ADMIN_POWER_LEVEL) {
        const gitterUserId = await store.getGitterUserIdByMatrixUserId(mxid);
        const gitterUser = await persistence.User.findById(gitterUserId, null, {
          lean: true
        }).exec();
        const policy = await policyFactory.createPolicyForRoom(gitterUser, gitterRoom);
        const canAdmin = await policy.canAdmin();

        // If the person no longer exists on Gitter or if the person can no longer admin
        // the Gitter room, remove their power levels from the Matrix room.
        if (!gitterUserId || !canAdmin) {
          await this.removeAdminFromMatrixRoomId({ mxid, matrixRoomId });
        }
      }
    }
  }

  // Loop through all Gitter admins (smartly) and add power levels for anyone that
  // passes the Gitter admin check.
  //
  // eslint-disable-next-line complexity
  async addAdminsInMatrixRoomIdAccordingToGitterRoomId({
    matrixRoomId,
    gitterRoomId,
    useShortcutToOnlyLookThroughExtraAdmins = false
  }) {
    assert(gitterRoomId);
    assert(matrixRoomId);

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(gitterRoom);
    // Not all rooms are in a group like ONE_TO_ONE's
    const gitterGroup = await groupService.findById(gitterRoom.groupId);

    // If the only admins in the room are specified manually, then we know that all of
    // the admins possible by looking at `sd.extraAdmins` and we can shortcut...
    const onlyUsingManualAdmins =
      gitterRoom.sd && gitterRoom.sd.type === null && gitterRoom.sd.admins === 'MANUAL';
    // If the room is inheriting from the group and the group is using manual
    // admins, then we know all admins possible by looking at the groups
    // `sd.extraAdmins` and we can shortcut...
    const inheritingFromGroupAndGroupUsingManualAdmins =
      gitterRoom.sd &&
      gitterRoom.sd.type === 'GROUP' &&
      gitterRoom.sd.admins === 'GROUP_ADMIN' &&
      gitterGroup &&
      gitterGroup.sd.type === null &&
      gitterGroup.sd.admins === 'MANUAL';

    const canGetAwayWithUsingShortcutOnly =
      useShortcutToOnlyLookThroughExtraAdmins ||
      onlyUsingManualAdmins ||
      inheritingFromGroupAndGroupUsingManualAdmins;

    let extraAdminsToCheck = (gitterRoom.sd && gitterRoom.sd.extraAdmins) || [];
    // If the room is inheriting from the group, also add on the group extraAdmins
    if (inheritingFromGroupAndGroupUsingManualAdmins) {
      extraAdminsToCheck = extraAdminsToCheck.concat(
        (gitterGroup.sd && gitterGroup.sd.extraAdmins) || []
      );
    }

    // This is the shortcut method where we only have to check over the extraAdmins
    for (const gitterExtraAdminUserId of extraAdminsToCheck) {
      const gitterUserMxid = await this.getOrCreateMatrixUserByGitterUserId(gitterExtraAdminUserId);

      await this.addAdminToMatrixRoomId({
        mxid: gitterUserMxid,
        matrixRoomId
      });
    }

    // Otherwise, we just have to loop through all room members and check for any admins present
    if (!canGetAwayWithUsingShortcutOnly) {
      const gitterMembershipStreamIterable = noTimeoutIterableFromMongooseCursor(
        (/*{ previousIdFromCursor }*/) => {
          const messageCursor = persistence.TroupeUser.find(
            {
              troupeId: gitterRoomId
              // Ideally, we would factor in `previousIdFromCursor` here but there isn't an
              // `_id` index for this to be efficient. Instead, we will just get a brand new
              // cursor starting from the beginning and try again.
              // TODO: ^ is this actually true?
            },
            { _id: 0, userId: 1 }
          )
            // Go from oldest to most recent so everything appears in the order it was sent in
            // the first place
            .sort({ _id: 'asc' })
            .lean()
            .read(mongoReadPrefs.secondaryPreferred)
            .batchSize(DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP)
            .cursor();

          return { cursor: messageCursor, batchSize: DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP };
        }
      );

      for await (const gitterRoomMembershipEntry of gitterMembershipStreamIterable) {
        const gitterRoomMemberUserId = gitterRoomMembershipEntry.userId;
        const gitterUser = await persistence.User.findById(gitterRoomMemberUserId, null, {
          lean: true
        }).exec();
        const policy = await policyFactory.createPolicyForRoom(gitterUser, gitterRoom);
        const canAdmin = await policy.canAdmin();

        // If the person can admin the Gitter room, add power levels to the Matrix room.
        if (canAdmin) {
          const gitterUserMxid = await this.getOrCreateMatrixUserByGitterUserId(
            gitterRoomMemberUserId
          );

          await this.addAdminToMatrixRoomId({ mxid: gitterUserMxid, matrixRoomId });
        }
      }
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
    await this.ensureRoomAlias(matrixRoomId, `#${gitterRoomId}:${configuredServerName}`);
    // Add a lowercase alias if necessary
    if (roomAlias.toLowerCase() !== roomAlias) {
      await this.ensureRoomAlias(matrixRoomId, roomAlias.toLowerCase());
    }
  }

  // eslint-disable-next-line max-statements, complexity
  async ensureCorrectRoomState(
    matrixRoomId,
    gitterRoomId,
    {
      // If the room already has an avatar, we can probably skip the whole avatar
      // download/upload process for now. Feel free to set this in utility scripts for
      // example.
      skipRoomAvatarIfExists = false,
      // We have some snowflake Matrix room permissions setup for some particular
      // communities to be able to self-manage and moderate. Avoid regressing them back
      // to defaults.
      keepExistingUserPowerLevels = true,
      // This option is used when we want to create a room where we can import all history
      // into. We want to leave the current room in place and have a separate room where
      // the history (because we're bound to mess up the import and not be happy later on)
      // will live that we can point to.
      shouldBeInRoomDirectory = true,
      // People should be able to chat in rooms by default. We only use this for historical Matrix rooms
      readOnly = false
    } = {}
  ) {
    const gitterRoom = await troupeService.findById(gitterRoomId);

    // Protect from accidentally running this on a ONE_TO_ONE room.
    assert.notStrictEqual(
      gitterRoom.sd && gitterRoom.sd.type,
      'ONE_TO_ONE',
      `ensureCorrectRoomState should not be used on ONE_TO_ONE rooms. gitterRoomId=${gitterRoomId}`
    );

    // Protect from accidentally running this on a Matrix DM room.
    const isMatrixDmRoom = !!discoverMatrixDmUri(gitterRoom.lcUri);
    assert.strictEqual(
      isMatrixDmRoom,
      false,
      `ensureCorrectRoomState should not be used on DM rooms with Matrix users. gitterRoomId=${gitterRoomId}`
    );

    const bridgeIntent = this.matrixBridge.getIntent();

    if (shouldBeInRoomDirectory) {
      // Set the aliases first because we can always change our own `#*:gitter.im`
      // namespaced aliases but we will not always be able to control the room itself to
      // update the name/topic, etc
      await this.ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom);
    }

    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.name',
      newContent: {
        name: gitterRoom.uri
      }
    });
    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.topic',
      newContent: {
        topic: gitterRoom.topic || ''
      }
    });
    // We don't have to gate this off behind `shouldBeInRoomDirectory` because this
    // won't change the room directory at all. This is just used as a hint for how
    // clients will display this room after it is tombstoned.
    //
    // This currently doesn't work because of `Error: M_BAD_ALIAS: Room alias
    // #xxx:server does not point to the room`. TODO: Update Synapse not to be so strict
    // as multiple rooms have `m.room.canonical_alias` all the time with room upgrades
    // const roomAlias = getCanonicalAliasForGitterRoomUri(gitterRoom.uri); await
    // this.ensureStateEvent({ matrixRoomId, eventType: 'm.room.canonical_alias', newContent: { alias: roomAlias } });

    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);

    const roomDirectoryVisibility = await bridgeIntent.matrixClient.getDirectoryVisibility(
      matrixRoomId
    );
    // Make sure the room is not in the room directory if *NOT* shouldBeInRoomDirectory
    if (!shouldBeInRoomDirectory && roomDirectoryVisibility !== 'private') {
      await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');
    }

    if (isGitterRoomPublic) {
      if (shouldBeInRoomDirectory && roomDirectoryVisibility !== 'public') {
        await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'public');
      }
      await this.ensureStateEvent({
        matrixRoomId,
        eventType: 'm.room.history_visibility',
        newContent: {
          history_visibility: 'world_readable'
        }
      });
      await this.ensureStateEvent({
        matrixRoomId,
        eventType: 'm.room.join_rules',
        newContent: {
          join_rule: 'public'
        }
      });
    }
    // Private
    else {
      // Private rooms should always *NOT* be in the room directory
      if (roomDirectoryVisibility !== 'private') {
        await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');
      }
      await this.ensureStateEvent({
        matrixRoomId,
        eventType: 'm.room.history_visibility',
        newContent: {
          history_visibility: 'shared'
        }
      });
      await this.ensureStateEvent({
        matrixRoomId,
        eventType: 'm.room.join_rules',
        newContent: {
          join_rule: 'invite'
        }
      });
    }

    // We have some snowflake Matrix room permissions setup for some particular
    // communities to be able to self-manage and moderate. Avoid regressing them back
    // to defaults.
    let existingUserPowerLevels = {};
    if (keepExistingUserPowerLevels) {
      const currentPowerLevelContent = await bridgeIntent.getStateEvent(
        matrixRoomId,
        'm.room.power_levels'
      );
      existingUserPowerLevels = (currentPowerLevelContent && currentPowerLevelContent.users) || {};
    }

    const bridgeMxid = this.getMxidForMatrixBridgeUser();
    // https://matrix.org/docs/spec/client_server/r0.2.0#m-room-power-levels
    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.power_levels',
      newContent: {
        users_default: 0,
        users: {
          ...existingUserPowerLevels,
          ...extraPowerLevelUsers,
          [bridgeMxid]: BRIDGE_USER_POWER_LEVEL
        },
        events: {
          'm.room.avatar': 50,
          'm.room.canonical_alias': 50,
          'm.room.encryption': ROOM_ADMIN_POWER_LEVEL,
          'm.room.history_visibility': ROOM_ADMIN_POWER_LEVEL,
          'm.room.name': 50,
          'm.room.power_levels': ROOM_ADMIN_POWER_LEVEL,
          'm.room.server_acl': ROOM_ADMIN_POWER_LEVEL,
          'm.room.tombstone': ROOM_ADMIN_POWER_LEVEL
        },
        events_default: readOnly ? 50 : 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0
      }
    });

    // Add the Gitter room admins to the power levels to be able to self-manage later
    await this.cleanupAdminsInMatrixRoomIdAccordingToGitterRoomId({
      matrixRoomId,
      gitterRoomId
    });
    await this.addAdminsInMatrixRoomIdAccordingToGitterRoomId({
      matrixRoomId,
      gitterRoomId
    });

    // TODO: Ensure historical predecessor set correctly. This function is also used for
    // historical rooms so be mindful

    let roomDisplayName;
    const gitterGroup = await groupService.findById(gitterRoom.groupId);
    if (gitterGroup) {
      // We do this because it's more correct for how the full name is displayed in
      // Gitter. The name of a group doesn't have to match the URI and often people have
      // nice display names with spaces so it appears like 'The Big Ocean/Fish'
      roomDisplayName = `${gitterGroup.name}/${getRoomNameFromTroupeName(gitterRoom.uri)}`;
    } else {
      roomDisplayName = gitterRoom.uri;
    }

    // Add some meta info about what GitHub/GitLab project/org this Gitter room is
    // associated with. This information is valuable not only to make sure the data
    // lives on in someway but also useful in Element (Matrix client) where the
    // integration manager could automatically suggest setting up the integration for
    // the assocatiaton.
    if (gitterRoom.sd && SD_TYPES_WITH_EXTERNAL_ASSOCIATION.includes(gitterRoom.sd.type)) {
      let platform;
      if (GITLAB_SD_TYPES.includes(gitterRoom.sd.type)) {
        platform = 'gitlab.com';
      } else if (GITHUB_SD_TYPES.includes(gitterRoom.sd.type)) {
        platform = 'github.com';
      }

      await this.ensureStateEvent({
        matrixRoomId,
        eventType: 'im.gitter.project_association',
        newContent: {
          platform,
          type: gitterRoom.sd.type,
          linkPath: gitterRoom.sd.linkPath,
          externalId: gitterRoom.sd.externalId
        }
      });
    }

    // Set the room avatar.
    // (set this last as it doesn't matter as much to the functionality if it fails)
    let currentRoomAvatarMxcUrl;
    try {
      const currentRoomAvatarContent = await bridgeIntent.getStateEvent(
        matrixRoomId,
        'm.room.avatar'
      );
      currentRoomAvatarMxcUrl = currentRoomAvatarContent && currentRoomAvatarContent.url;
    } catch (err) {
      // no-op when `M_NOT_FOUND: Event not found` because it's ok for not every room to
      // have an avatar set
    }
    let roomMxcUrl = currentRoomAvatarMxcUrl;
    if (!skipRoomAvatarIfExists || (skipRoomAvatarIfExists && !currentRoomAvatarMxcUrl)) {
      const roomAvatarUrl = avatars.getForGroupId(gitterRoom.groupId);
      roomMxcUrl = await this.uploadAvatarUrlToMatrix(roomAvatarUrl);
      if (roomMxcUrl) {
        await this.ensureStateEvent({
          matrixRoomId,
          eventType: 'm.room.avatar',
          newContent: {
            url: roomMxcUrl
          }
        });
      }
    }

    // Add some meta info to cross-link and show that the Matrix room is bridged over to Gitter.
    // (this has to be last-last because it uses the avatar uploaded from before)
    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'uk.half-shot.bridge',
      newContent: {
        bridgebot: this.getMxidForMatrixBridgeUser(),
        protocol: {
          id: 'gitter',
          displayname: 'Gitter',
          avatar_url: gitterLogoMxc,
          external_url: 'https://gitter.im/'
        },
        channel: {
          id: gitterRoom.id,
          displayname: roomDisplayName,
          avatar_url: roomMxcUrl,
          external_url: urlJoin(config.get('web:basepath'), gitterRoom.uri)
        }
      }
    });
  }

  async ensureCorrectHistoricalMatrixRoomStateBeforeImport({
    // The historical room to ensure correct state in
    matrixHistoricalRoomId,
    gitterRoomId,
    // Just pass this along to `ensureCorrectRoomState(...)`
    skipRoomAvatarIfExists
  }) {
    assert(matrixHistoricalRoomId);
    assert(gitterRoomId);

    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `ensureCorrectHistoricalMatrixRoomStateBeforeImport: gitterRoomId=${gitterRoomId} unexpectedly does not exist`
    );

    // One to one rooms are setup correctly from the beginning and never need updates
    if (gitterRoom.sd.type !== 'ONE_TO_ONE') {
      // Propagate all of the room details over to Matrix like the room topic and avatar
      await this.ensureCorrectRoomState(matrixHistoricalRoomId, gitterRoomId, {
        // Just pass this along
        skipRoomAvatarIfExists,
        // We don't want this historical room to show up in the room directory. It will
        // only be pointed back to by the current room in its predecessor.
        shouldBeInRoomDirectory: false,
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
    gitterRoomId,
    // Just pass this along to `ensureCorrectRoomState(...)`
    skipRoomAvatarIfExists
  }) {
    assert(matrixRoomId);
    assert(matrixHistoricalRoomId);
    assert(gitterRoomId);
    const gitterRoom = await troupeService.findById(gitterRoomId);
    assert(
      gitterRoom,
      `ensureCorrectHistoricalMatrixRoomStateAfterImport: gitterRoomId=${gitterRoomId} unexpectedly does not exist`
    );

    // One to one rooms are setup correctly from the beginning and never need updates
    if (gitterRoom.sd.type !== 'ONE_TO_ONE') {
      // Propagate all of the room details over to Matrix like the room topic and avatar
      await this.ensureCorrectRoomState(matrixHistoricalRoomId, gitterRoomId, {
        // Just pass this along
        skipRoomAvatarIfExists,
        // We don't want this historical room to show up in the room directory. It will
        // only be pointed back to by the current room in its predecessor.
        shouldBeInRoomDirectory: false,
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
      await this.ensureStateEventAsMxid({
        mxid: gitterUserCreatorMxid,
        matrixRoomId: matrixHistoricalRoomId,
        eventType: 'm.room.tombstone',
        newContent: {
          replacement_room: matrixRoomId
        }
      });
    } else {
      // Ensure tombstone event pointing to the main live room
      await this.ensureStateEvent({
        matrixRoomId: matrixHistoricalRoomId,
        eventType: 'm.room.tombstone',
        newContent: {
          replacement_room: matrixRoomId
        }
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
    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.history_visibility',
      newContent: {
        history_visibility: 'joined'
      }
    });

    const bridgeIntent = this.matrixBridge.getIntent();

    // Remove it from the room directory
    debug(`shutdownMatrixRoom(${matrixRoomId}): Removing room from directory`);
    await bridgeIntent.matrixClient.setDirectoryVisibility(matrixRoomId, 'private');

    // Make it so people can't join back in
    debug(
      `shutdownMatrixRoom(${matrixRoomId}): Changing the join_rules to invite-only so people can't join back`
    );
    await this.ensureStateEvent({
      matrixRoomId,
      eventType: 'm.room.join_rules',
      newContent: {
        join_rule: 'invite'
      }
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

  async getOrCreateMatrixRoomByGitterRoomId(
    gitterRoomId,
    { tryToResolveConflictFromRoomDirectory = true } = {}
  ) {
    // Find the cached existing bridged room
    const existingMatrixRoomId = await store.getMatrixRoomIdByGitterRoomId(gitterRoomId);
    if (existingMatrixRoomId) {
      return existingMatrixRoomId;
    }

    // Create the Matrix room since one doesn't already exist
    logger.info(
      `Existing Matrix room not found, creating new Matrix room for roomId=${gitterRoomId}`
    );

    let matrixRoomId;
    try {
      matrixRoomId = await this.createMatrixRoomByGitterRoomId(gitterRoomId);
    } catch (err) {
      // Try to resolve the conflict by just picking up the room that is in the room
      // directory as the source of truth since we used that as the locking mechanism in
      // the first place.
      if (
        tryToResolveConflictFromRoomDirectory &&
        err.statusCode === 400 &&
        err.body.errcode === 'M_ROOM_IN_USE'
      ) {
        logger.info(
          `Trying to resolve conflict where a Matrix Room already exists with a conflicting alias ` +
            `but we don't have it stored for the Gitter room (gitterRoomId=${gitterRoomId}). Looking it up in the Matrix room directory...`
        );
        const gitterRoom = await troupeService.findById(gitterRoomId);
        assert(
          gitterRoom,
          `Unable to resolve conflict where a Matrix Room already exists with a conflicting alias ` +
            `but we don't have it stored for the Gitter room because: the Gitter room unexpectedly ` +
            `does not exist for gitterRoomId=${gitterRoomId}`
        );
        const roomAlias = await getCanonicalAliasForGitterRoomUri(gitterRoom.uri);
        ({ roomId: matrixRoomId } = await this.lookupRoomAlias(roomAlias));

        if (!matrixRoomId) {
          throw new Error(
            `Room directory unexpectedly did not have ${roomAlias} but it just gave us M_ROOM_IN_USE so it should exist or it was just deleted between our two requests. Unable to resolve conflict.`
          );
        }
      } else {
        throw err;
      }
    }
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

    const matrixHistoricalRoomId = await this.createMatrixRoomByGitterRoomId(gitterRoomId, {
      // We don't want this historical room to show up in the room directory. It will
      // only be pointed back to by the current room in its predecessor.
      shouldBeInRoomDirectory: false
    });
    // Store the bridged room right away!
    // If we created a bridged room, we want to make sure we store it 100% of the time
    logger.info(
      `Storing bridged historical room (Gitter room id=${gitterRoomId} -> Matrix room_id=${matrixHistoricalRoomId})`
    );
    await store.storeBridgedHistoricalRoom(gitterRoomId, matrixHistoricalRoomId);

    await this.ensureCorrectHistoricalMatrixRoomStateBeforeImport({
      matrixHistoricalRoomId,
      gitterRoomId
    });

    return matrixHistoricalRoomId;
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
      await intent.setDisplayName(
        // The max displayName length is 256 characters so trim it down as necessary.
        // Just do a harsh cut for now (it's not critical)
        desiredDisplayName.substring(0, 256)
      );
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
    const mxid = `@${matrixBridgeMxidLocalpart}:${configuredServerName}`;
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
        const responseError = new StatusError(
          res.statusCode,
          `sendEventAtTimestmap({ matrixRoomId: ${matrixRoomId} }) failed ${
            res.statusCode
          }: ${JSON.stringify(res.body)}`
        );
        // Attach a little bit more of info to work from. This is a little bit hacky :shrug:
        if (res.body && res.body.errcode) {
          responseError.errcode = res.body.errcode;
        }

        throw responseError;
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

  async getRoomMembers({ matrixRoomId, membership }) {
    assert(matrixRoomId);
    assert(['invite', 'join', 'leave', 'knock', 'ban'].includes(membership));

    const _getRoomMembersWrapper = async () => {
      const homeserverUrl = this.matrixBridge.opts.homeserverUrl;
      assert(homeserverUrl);
      const asToken = this.matrixBridge.registration.getAppServiceToken();
      assert(asToken);

      let qs = new URLSearchParams();
      qs.append('membership', membership);

      const membersEndpoint = `${homeserverUrl}/_matrix/client/r0/rooms/${matrixRoomId}/members?${qs.toString()}`;
      const res = await request({
        method: 'GET',
        uri: membersEndpoint,
        json: true,
        headers: {
          Authorization: `Bearer ${asToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (res.statusCode !== 200) {
        throw new StatusError(
          res.statusCode,
          `getRoomMembers({ matrixRoomId: ${matrixRoomId}, membership: ${membership} }) failed ${
            res.statusCode
          }: ${JSON.stringify(res.body)}`
        );
      }

      return res;
    };

    let res;
    try {
      // Try the happy-path first and assume we're joined to the room
      res = await _getRoomMembersWrapper();
    } catch (err) {
      // If we get a 403 forbidden indicating we're not in the room yet, let's try to join
      if (err.status === 403) {
        const intent = this.matrixBridge.getIntent();
        await intent._ensureJoined(matrixRoomId);
      } else {
        // We don't know how to recover from an arbitrary error that isn't about joining
        throw err;
      }

      // Now that we're joined, try again
      res = await _getRoomMembersWrapper();
    }

    if (res.body.chunk === undefined) {
      throw new StatusError(
        res.statusCode,
        `getRoomMembers({ matrixRoomId: ${matrixRoomId}, membership: ${membership} }) did not return the response body we expected (wanted \`res.body.chunk\`) ${
          res.statusCode
        }: ${JSON.stringify(res.body)}`
      );
    }

    return res.body.chunk;
  }

  async lookupRoomAlias(roomAlias) {
    const homeserverUrl = this.matrixBridge.opts.homeserverUrl;
    assert(homeserverUrl);
    const asToken = this.matrixBridge.registration.getAppServiceToken();
    assert(asToken);

    const roomDirectoryEndpoint = `${homeserverUrl}/_matrix/client/r0/directory/room/${encodeURIComponent(
      roomAlias
    )}`;
    const res = await request({
      method: 'GET',
      uri: roomDirectoryEndpoint,
      json: true,
      headers: {
        Authorization: `Bearer ${asToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.statusCode !== 200) {
      const responseError = new StatusError(
        res.statusCode,
        `lookupRoomAlias({ roomAlias: ${roomAlias} }) failed ${res.statusCode}: ${JSON.stringify(
          res.body
        )}`
      );
      // Attach a little bit more of info to work from. This is a little bit hacky :shrug:
      if (res.body && res.body.errcode) {
        responseError.errcode = res.body.errcode;
      }

      throw responseError;
    }

    return {
      roomId: res.body.room_id,
      servers: res.body.servers
    };
  }
}

module.exports = MatrixUtils;
