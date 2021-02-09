'use strict';

const debug = require('debug')('gitter:app:matrix-bridge:matrix-utils');
const assert = require('assert');
const request = require('request');
const path = require('path');
const urlJoin = require('url-join');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const groupService = require('gitter-web-groups');
const userService = require('gitter-web-users');
const avatars = require('gitter-web-avatars');
const getRoomNameFromTroupeName = require('gitter-web-shared/get-room-name-from-troupe-name');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;

const store = require('./store');

const serverName = config.get('matrix:bridge:serverName');
// The bridge user we are using to interact with everything on the Matrix side
const matrixBridgeMxidLocalpart = config.get('matrix:bridge:matrixBridgeMxidLocalpart');
const gitterLogoMxc = config.get('matrix:bridge:gitterLogoMxc');

/**
 * downloadFile - This function will take a URL and store the resulting data into
 * a buffer.
 */
// Based on https://github.com/Half-Shot/matrix-appservice-discord/blob/7fc714d36943e2591a828a8a6481db37119c3bdc/src/util.ts#L65-L96
const HTTP_OK = 200;
async function downloadFileToBuffer(url) {
  return new Promise((resolve, reject) => {
    // Using `request` here to follow any redirects
    const req = request(url);

    // TODO: Implement maxSize to reject, req.abort()
    let buffer = Buffer.alloc(0);
    req.on('data', d => {
      buffer = Buffer.concat([buffer, d]);
    });

    req.on('response', res => {
      if (res.statusCode !== HTTP_OK) {
        reject(`Non 200 status code (${res.statusCode})`);
      }

      req.on('end', () => {
        resolve({
          buffer,
          mimeType: res.headers['content-type']
        });
      });
    });

    req.on('error', err => {
      reject(`Failed to download. ${err}`);
    });
  });
}

class MatrixUtils {
  constructor(matrixBridge) {
    this.matrixBridge = matrixBridge;
  }

  getCanonicalAliasForGitterRoomUri(uri) {
    return uri.replace('/', '_');
  }

  async createMatrixRoomByGitterRoomId(gitterRoomId) {
    const gitterRoom = await troupeService.findById(gitterRoomId);
    const roomAlias = this.getCanonicalAliasForGitterRoomUri(gitterRoom.uri);

    const bridgeIntent = this.matrixBridge.getIntent();

    const newRoom = await bridgeIntent.createRoom({
      createAsClient: true,
      options: {
        name: gitterRoom.uri,
        visibility: 'public',
        preset: 'public_chat',
        // We use this as a locking mechanism.
        // The bridge will return an error: `M_ROOM_IN_USE: Room alias already taken`
        // if another process is already in the working on creating the room
        room_alias_name: roomAlias
      }
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
    let currentAliasedRoom;
    try {
      currentAliasedRoom = await bridgeIntent.getClient().getRoomIdForAlias(alias);
    } catch (err) {
      // no-op
    }

    if (currentAliasedRoom && currentAliasedRoom.room_id === matrixRoomId) {
      isAliasAlreadySet = true;
    } else if (currentAliasedRoom) {
      // Delete the alias from the other room
      await bridgeIntent.getClient().deleteAlias(alias);
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
    const roomAlias = this.getCanonicalAliasForGitterRoomUri(gitterRoom.uri);
    await this.ensureRoomAlias(matrixRoomId, `#${roomAlias}:${serverName}`);
    // Add another alias for the room ID
    await this.ensureRoomAlias(matrixRoomId, `#${gitterRoomId}:${serverName}`);
    // Add a lowercase alias if necessary
    if (roomAlias.toLowerCase() !== roomAlias) {
      await this.ensureRoomAlias(matrixRoomId, `#${roomAlias.toLowerCase()}:${serverName}`);
    }
  }

  async ensureCorrectRoomState(matrixRoomId, gitterRoomId) {
    const gitterRoom = await troupeService.findById(gitterRoomId);
    const gitterGroup = await groupService.findById(gitterRoom.groupId);

    const bridgeIntent = this.matrixBridge.getIntent();

    await this.ensureStateEvent(matrixRoomId, 'm.room.name', {
      name: gitterRoom.uri
    });
    await this.ensureStateEvent(matrixRoomId, 'm.room.topic', {
      topic: gitterRoom.topic
    });

    const roomDirectoryVisibility = await bridgeIntent
      .getClient()
      .getRoomDirectoryVisibility(matrixRoomId);
    if (roomDirectoryVisibility !== 'public') {
      await bridgeIntent.getClient().setRoomDirectoryVisibility(matrixRoomId, 'public');
    }
    await this.ensureStateEvent(matrixRoomId, 'm.room.history_visibility', {
      history_visibility: 'world_readable'
    });
    await this.ensureStateEvent(matrixRoomId, 'm.room.join_rules', {
      join_rule: 'public'
    });

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

    await this.ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom);

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

  async ensureCorrectMxidProfile(mxid, gitterUserId) {
    const gitterUser = await userService.findById(gitterUserId);

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

  getMxidForGitterUser(gitterUser) {
    const mxid = `@${gitterUser.username.toLowerCase()}-${gitterUser.id}:${serverName}`;
    return mxid;
  }

  async getOrCreateMatrixUserByGitterUserId(gitterUserId) {
    const existingMatrixUserId = await store.getMatrixUserIdByGitterUserId(gitterUserId);
    if (existingMatrixUserId) {
      return existingMatrixUserId;
    }

    const gitterUser = await userService.findById(gitterUserId);
    const mxid = this.getMxidForGitterUser(gitterUser);
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

    const gitterUser = await userService.findByUsername(matrixBridgeMxidLocalpart);
    await this.ensureCorrectMxidProfile(mxid, gitterUser.id);
  }
}

module.exports = MatrixUtils;
