'use strict';

const assert = require('assert');
const groupService = require('gitter-web-groups/lib/group-service');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomService = require('gitter-web-rooms');
const userService = require('gitter-web-users');

const env = require('gitter-web-env');
const logger = env.logger;

const getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid = require('./get-gitter-dm-room-uri-by-gitter-user-id-and-other-person-mxid');

class GitterUtils {
  constructor(matrixBridge, bridgeConfig) {
    this.matrixBridge = matrixBridge;
    this.bridgeConfig = bridgeConfig;

    assert(this.matrixBridge, 'Matrix bridge required');
    assert(this.bridgeConfig, 'Bridge config required');
    assert(this.bridgeConfig.gitterBridgeUsername);
    assert(this.bridgeConfig.matrixDmGroupUri);
  }

  async createGitterDmRoomByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid) {
    assert(gitterUserId);
    assert(otherPersonMxid);

    const gitterUser = await userService.findById(gitterUserId);
    assert(gitterUser);

    const gitterRoomUri = getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(
      gitterUserId,
      otherPersonMxid
    );

    // Create the DM room on the Gitter side
    const gitterBridgeUser = await userService.findByUsername(
      this.bridgeConfig.gitterBridgeUsername
    );
    assert(gitterBridgeUser);

    const group = await groupService.findByUri(this.bridgeConfig.matrixDmGroupUri, { lean: true });
    assert(group);

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
      `Joining Gitter user (username=${gitterUser.username}, userId=${gitterUserId}) to the DM room on Gitter (gitterRoomId=${newDmRoom._id}, gitterRoomLcUri=${newDmRoom.lcUri})`
    );

    // Join the Gitter user to the new Gitter DM room
    await roomService.joinRoom(newDmRoom, gitterUser, {
      tracking: { source: 'matrix-dm' }
    });

    return newDmRoom;
  }

  async getGitterDmRoomByGitterUserAndOtherPersonMxid(gitterUser, otherPersonMxid) {
    assert(gitterUser);
    assert(otherPersonMxid);

    const gitterUserId = gitterUser.id || gitterUser._id;

    // Check to see if the DM room on Gitter already exists with this person
    const gitterDmRoom = await troupeService.findByUri(
      getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid)
    );

    return gitterDmRoom;
  }

  async getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(gitterUser, otherPersonMxid) {
    const gitterDmRoom = await this.getGitterDmRoomByGitterUserAndOtherPersonMxid(
      gitterUser,
      otherPersonMxid
    );
    if (gitterDmRoom) {
      return gitterDmRoom;
    }

    const gitterUserId = gitterUser.id || gitterUser._id;

    // Create the Matrix room if it doesn't already exist
    logger.info(
      `Existing Gitter room not found for Matrix DM, creating new Gitter room for gitterUserId=${gitterUserId} and otherPersonMxid=${otherPersonMxid}`
    );

    const gitterRoom = await this.createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
      gitterUserId,
      otherPersonMxid
    );

    return gitterRoom;
  }
}

module.exports = GitterUtils;
