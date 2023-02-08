'use strict';

const assert = require('assert');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
const userService = require('gitter-web-users');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomMembershipService = require('gitter-web-rooms/lib/room-membership-service');
const securityDescriptorUtils = require('gitter-web-permissions/lib/security-descriptor-utils');

const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const extraPowerLevelUsers = require('gitter-web-matrix-bridge/lib/extra-power-level-users-from-config');
const parseGitterMxid = require('gitter-web-matrix-bridge/lib/parse-gitter-mxid');
const RethrownError = require('./rethrown-error');

const configuredServerName = config.get('matrix:bridge:serverName');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP = 100;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;

const MXIDS_TO_NEVER_REMOVE = [
  matrixUtils.getMxidForMatrixBridgeUser(),
  ...Object.keys(extraPowerLevelUsers)
];

async function ensureNoExtraMembersInMatrixRoom({
  gitterRoomId,
  matrixRoomId,
  alreadyJoinedGitterUserIdsToMatrixRoom
}) {
  // Loop through all members in the current Matrix room, remove if they are no longer
  // present in the Gitter room.
  const matrixMemberEvents = await matrixUtils.getRoomMembers({
    matrixRoomId,
    membership: 'join'
  });
  for (const matrixMemberEvent of matrixMemberEvents) {
    const mxid = matrixMemberEvent.state_key;
    // Skip any MXID's that aren't from our own server (gitter.im)
    const { serverName } = parseGitterMxid(mxid) || {};
    if (serverName !== configuredServerName) {
      continue;
    }

    // We don't want to ever remove the bridge user or other special users (like the
    // Mjolnir moderation user) from the room
    if (MXIDS_TO_NEVER_REMOVE.includes(mxid)) {
      continue;
    }

    const gitterUserId = await matrixStore.getGitterUserIdByMatrixUserId(mxid);
    // Remove the user if they aren't tracked by us as bridged. This really shouldn't
    // happen because if they're in the room, by its nature, we bridged something before
    // but somehow lost track now.
    if (!gitterUserId) {
      logger.warn(
        `mxid=${mxid} was in ${matrixRoomId} but we don't have a corresponding bridged user entry for it so we can't find the gitterUserId associated. It's probably obvious from the MXID itself but we're just removing the user to be safe`
      );
      const intent = matrixBridge.getIntent(mxid);
      await intent.leave(matrixRoomId);
      continue;
    }

    // Or `roomMembershipService.findUserMembershipInRooms`
    const isGitterRoomMember = await roomMembershipService.checkRoomMembership(
      gitterRoomId,
      gitterUserId
    );
    // Save this look-up so we can re-use it below when we loop over
    alreadyJoinedGitterUserIdsToMatrixRoom[gitterUserId] = isGitterRoomMember;

    // Remove from Matrix room if they are no longer part of the room on Gitter
    if (!isGitterRoomMember) {
      const intent = matrixBridge.getIntent(mxid);
      await intent.leave(matrixRoomId);
    }
  }
}

async function ensureMembershipFromGitterRoom({
  gitterRoomId,
  matrixRoomId,
  alreadyJoinedGitterUserIdsToMatrixRoom
}) {
  assert(gitterRoomId);
  assert(matrixRoomId);
  assert(alreadyJoinedGitterUserIdsToMatrixRoom);

  const gitterMembershipStreamIterable = noTimeoutIterableFromMongooseCursor(
    (/*{ previousIdFromCursor }*/) => {
      const roomMemberCursor = persistence.TroupeUser.find(
        {
          troupeId: gitterRoomId
          // Ideally, we would factor in `previousIdFromCursor` here but there isn't an
          // `_id` index for this to be efficient. Instead, we will just get a brand new
          // cursor starting from the beginning and try again.
          // TODO: ^ is this actually true?
        },
        { userId: 1 }
      )
        // Go from oldest to most recent so everything appears in the order it was sent in
        // the first place
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP)
        .cursor();

      return { cursor: roomMemberCursor, batchSize: DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP };
    }
  );

  // Loop through all members of the Gitter room, and join anyone who is not already present.
  for await (const gitterRoomMembershipEntry of gitterMembershipStreamIterable) {
    const gitterRoomMemberUserId = gitterRoomMembershipEntry.userId;

    // We can skip if we already know the Gitter user is joined to the Matrix room from the
    // previous loop
    if (alreadyJoinedGitterUserIdsToMatrixRoom[gitterRoomMemberUserId]) {
      continue;
    }

    let gitterUserMxid;
    try {
      gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
        gitterRoomMemberUserId
      );
    } catch (err) {
      const gitterUser = await userService.findById(gitterRoomMemberUserId);
      if (gitterUser) {
        throw new RethrownError(
          `ensureMembershipFromGitterRoom: Failed to getOrCreateMatrixUserByGitterUserId for gitterRoomMemberUserId=${gitterRoomMemberUserId} (${gitterUser.username})`,
          err
        );
      } else {
        logger.warn(
          `gitterUserId=${gitterRoomMemberUserId} was in gitterRoomId=${gitterRoomId} but the Gitter user does not exist so ignoring`
        );
        // Skip to the next room member
        continue;
      }
    }

    // Join Gitter user to the Matrix room
    try {
      const intent = matrixBridge.getIntent(gitterUserMxid);
      // XXX: We should be using `intent.join(...)` here but there isn't a way to get
      // the true error masking the failed join without using
      // `intent._ensureJoined(...)` with the `passthroughError` option.
      await intent._ensureJoined(
        matrixRoomId,
        // ignoreCache (default)
        false,
        // viaServers
        undefined,
        // passthroughError
        true
      );
    } catch (err) {
      throw new RethrownError(
        `ensureMembershipFromGitterRoom: Failed to join gitterUserMxid=${gitterUserMxid} to matrixRoomId=${matrixRoomId}`,
        err
      );
    }
  }
}

async function syncMatrixRoomMembershipFromGitterRoomIdToMatrixRoomId({
  gitterRoomId,
  matrixRoomId
}) {
  assert(gitterRoomId);
  assert(matrixRoomId);

  const alreadyJoinedGitterUserIdsToMatrixRoom = {};

  await ensureNoExtraMembersInMatrixRoom({
    gitterRoomId,
    matrixRoomId,
    alreadyJoinedGitterUserIdsToMatrixRoom
  });

  await ensureMembershipFromGitterRoom({
    gitterRoomId,
    matrixRoomId,
    alreadyJoinedGitterUserIdsToMatrixRoom
  });
}

// eslint-disable-next-line max-statements, complexity
async function syncMatrixRoomMembershipFromGitterRoom(gitterRoom) {
  const gitterRoomId = gitterRoom.id || gitterRoom._id;
  assert(gitterRoomId);

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  assert(matrixRoomId);

  // Sync membership so they see the same rooms on Matrix that they were in on Gitter.
  await syncMatrixRoomMembershipFromGitterRoomIdToMatrixRoomId({ gitterRoomId, matrixRoomId });

  // Also handle the historical room if it exists
  const matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );
  if (matrixHistoricalRoomId) {
    const alreadyJoinedGitterUserIdsToMatrixRoom = {};
    // Always clean-up extra members in historical room
    await ensureNoExtraMembersInMatrixRoom({
      gitterRoomId,
      matrixRoomId: matrixHistoricalRoomId,
      alreadyJoinedGitterUserIdsToMatrixRoom
    });

    const gitterRoom = await troupeService.findById(gitterRoomId);
    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);
    // But since people can always join a historical room on their own if it's public,
    // we only need to worry about giving people access in non-public rooms (private,
    // ONE_TO_ONE).
    if (!isGitterRoomPublic) {
      await ensureMembershipFromGitterRoom({
        gitterRoomId,
        matrixRoomId: matrixHistoricalRoomId,
        alreadyJoinedGitterUserIdsToMatrixRoom
      });
    }
  }
}

module.exports = { syncMatrixRoomMembershipFromGitterRoom };
