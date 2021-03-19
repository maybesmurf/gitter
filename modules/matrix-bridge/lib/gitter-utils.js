'use strict';

const assert = require('assert');
const groupService = require('gitter-web-groups/lib/group-service');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomService = require('gitter-web-rooms');
const userService = require('gitter-web-users');

const env = require('gitter-web-env');
const logger = env.logger;

const store = require('./store');

class GitterUtils {
  constructor(gitterBridgeUsername) {
    assert(
      gitterBridgeUsername,
      'gitterBridgeUsername required (the bot user on the Gitter side that bridges messages like gitter-badger or matrixbot)'
    );
    this._gitterBridgeUsername = gitterBridgeUsername;
  }

  getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid) {
    assert(gitterUserId);
    assert(otherPersonMxid);

    const gitterRoomUri = `matrix/${gitterUserId}/${otherPersonMxid}`;
    return gitterRoomUri;
  }

  async createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
    matrixRoomId,
    gitterUserId,
    otherPersonMxid
  ) {
    assert(matrixRoomId);
    assert(gitterUserId);
    assert(otherPersonMxid);

    const gitterRoomUri = this.getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(
      gitterUserId,
      otherPersonMxid
    );

    // Create the DM room on the Gitter side
    const gitterBridgeUser = await userService.findByUsername(this._gitterBridgeUsername);
    assert(gitterBridgeUser);

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

  async getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
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

    const gitterRoom = await this.createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
      matrixRoomId,
      gitterUserId,
      otherPersonMxid
    );

    return gitterRoom;
  }
}

module.exports = GitterUtils;
