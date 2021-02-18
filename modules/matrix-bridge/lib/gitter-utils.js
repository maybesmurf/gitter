'use strict';

const assert = require('assert');
const groupService = require('gitter-web-groups/lib/group-service');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomService = require('gitter-web-rooms');
const userService = require('gitter-web-users');
const securityDescriptorUtils = require('gitter-web-permissions/lib/security-descriptor-utils');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;

const store = require('./store');

const gitterRoomAllowList = config.get('matrix:bridge:gitterRoomAllowList');
const gitterBridgeUsername = config.get('matrix:bridge:gitterBridgeUsername');

let allowedRoomMap;
if (gitterRoomAllowList) {
  allowedRoomMap = gitterRoomAllowList.reduce((map, allowedRoomId) => {
    map[allowedRoomId] = true;
    return map;
  }, {});
}

const MATRIX_DM_RE = /^matrix\/[0-9a-f]+\/@.*?/;

async function isGitterRoomIdAllowedToBridge(gitterRoomId) {
  // Only public rooms can bridge messages
  const gitterRoom = await troupeService.findById(gitterRoomId);

  if (!gitterRoom) {
    return false;
  }

  // Check for a Matrix DM room
  const matches = gitterRoom.lcUri.match(MATRIX_DM_RE);
  if (matches) {
    return true;
  }

  const isPublic = securityDescriptorUtils.isPublic(gitterRoom);
  if (!isPublic) {
    return false;
  }

  // If no allowlist was configured, then allow any room to bridge (useful to wildcard all testing in dev/beta).
  if (!allowedRoomMap) {
    return true;
  }

  // In production, we limit the rooms that are bridged in our initial testing phase
  // to limit any bad side-effects that may occur.
  const stringifiedRoomId = mongoUtils.serializeObjectId(gitterRoomId);
  return !!allowedRoomMap[stringifiedRoomId];
}

function getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid) {
  assert(gitterUserId);
  assert(otherPersonMxid);

  const gitterRoomUri = `matrix/${gitterUserId}/${otherPersonMxid}`;
  return gitterRoomUri;
}

async function createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
  matrixRoomId,
  gitterUserId,
  otherPersonMxid
) {
  assert(matrixRoomId);
  assert(gitterUserId);
  assert(otherPersonMxid);

  const gitterRoomUri = getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(
    gitterUserId,
    otherPersonMxid
  );

  // Create the DM room on the Gitter side
  const gitterBridgeUser = await userService.findByUsername(gitterBridgeUsername);
  const group = await groupService.findByUri('matrix', { lean: true });
  const roomInfo = {
    uri: gitterRoomUri,
    topic: `A one to one chat room with ${otherPersonMxid} from Matrix`
  };
  const securityDescriptor = {
    extraAdmins: [],
    extraMembers: [gitterUserId],
    members: 'INVITE',
    public: false,
    admins: 'MANUAL',
    type: null
  };
  const { troupe: newDmRoom } = await roomService.createGroupRoom(
    gitterBridgeUser,
    group,
    roomInfo,
    securityDescriptor,
    {
      tracking: { source: 'matrix-dm' }
    }
  );

  logger.info(
    `Storing bridged DM room (Gitter room id=${newDmRoom._id} -> Matrix room_id=${matrixRoomId}): ${newDmRoom.lcUri}`
  );
  await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

  return newDmRoom;
}

async function getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
  matrixRoomId,
  gitterUserId,
  otherPersonMxid
) {
  assert(matrixRoomId);
  assert(gitterUserId);
  assert(otherPersonMxid);

  // Find the existing bridged DM room
  const existingGitterRoomId = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
  if (existingGitterRoomId) {
    const gitterRoom = await troupeService.findById(existingGitterRoomId);
    // Just log a warning if it doesn't exist, we'll recover below by creating a new room
    if (!gitterRoom) {
      logger.warn(
        `Unable to find Gitter room with id=${existingGitterRoomId} for bridged Matrix DM room ${matrixRoomId}`
      );
    }

    if (gitterRoom) {
      return gitterRoom;
    }
  }

  // Create the Matrix room if it doesn't already exist
  logger.info(
    `Existing Gitter room not found for Matrix DM, creating new Gitter room for gitterUserId=${gitterUserId} otherPersonMxid=${otherPersonMxid}`
  );

  const gitterRoom = await createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
    matrixRoomId,
    gitterUserId,
    otherPersonMxid
  );

  return gitterRoom;
}

module.exports = {
  isGitterRoomIdAllowedToBridge,
  getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid,
  getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid
};
