'use strict';

const assert = require('assert');
const env = require('gitter-web-env');
const config = env.config;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomMembershipService = require('gitter-web-rooms/lib/room-membership-service');
const securityDescriptorUtils = require('gitter-web-permissions/lib/security-descriptor-utils');

const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const parseGitterMxid = require('gitter-web-matrix-bridge/lib/parse-gitter-mxid');

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

async function ensureNoExtraMembersInMatrixRoom({
  gitterRoomId,
  matrixRoomId,
  alreadyJoinedGitterUserIdsToMatrixRoom
}) {
  // Loop through all members in the current Matrix room, remove if they are no longer
  // present in the Gitter room.
  const matrixMemberEvents = await matrixUtils.getRoomMembers({
    matrixRoomId,
    membership: 'joined'
  });
  for (const matrixMemberEvent of matrixMemberEvents) {
    const mxid = matrixMemberEvent.state_key;
    // Skip any MXID's that aren't from our own server (gitter.im)
    const { serverName } = parseGitterMxid(mxid) || {};
    if (serverName !== configuredServerName) {
      continue;
    }

    const gitterUserId = await matrixStore.getGitterUserIdByMatrixUserId(mxid);

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
      const messageCursor = persistence.TroupeUser.find(
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

      return { cursor: messageCursor, batchSize: DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP };
    }
  );

  // Loop through all members of the Gitter room, and join anyone who is not already present.
  for await (const gitterRoomMembershipEntry of gitterMembershipStreamIterable) {
    const gitterRoomMemberUserId = gitterRoomMembershipEntry.userId;

    const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      gitterRoomMemberUserId
    );

    // We can skip if we already know the Gitter user is joined to the Matrix room from the
    // previous loop
    if (alreadyJoinedGitterUserIdsToMatrixRoom[gitterRoomMemberUserId]) {
      continue;
    }

    // Join Gitter user to the "live" room
    const intent = matrixBridge.getIntent(gitterUserMxid);
    await intent.join(matrixRoomId);
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

  const matrixRoomId = matrixStore.getMatrixRoomIdByGitterRoomId(gitterRoomId);
  assert(matrixRoomId);

  // Sync membership so they see the same rooms on Matrix that they were in on Gitter.
  await syncMatrixRoomMembershipFromGitterRoomIdToMatrixRoomId({ gitterRoomId, matrixRoomId });

  // Also handle the historical room if it exists
  const matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );
  if (matrixHistoricalRoomId) {
    // People can always join a historical room on their own if it's public so we only
    // need to worry about non-public rooms (private, ONE_TO_ONE) here.
    const gitterRoom = await troupeService.findById(gitterRoomId);
    const isGitterRoomPublic = securityDescriptorUtils.isPublic(gitterRoom);
    if (!isGitterRoomPublic) {
      await syncMatrixRoomMembershipFromGitterRoomIdToMatrixRoomId({
        gitterRoomId,
        matrixRoomId: matrixHistoricalRoomId
      });
    }
  }
}

module.exports = { syncMatrixRoomMembershipFromGitterRoom };
