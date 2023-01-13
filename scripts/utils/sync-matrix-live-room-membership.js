#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
//const debug = require('debug')('gitter:scripts:reset-all-matrix-historical-room-bridging');
const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const persistence = require('gitter-web-persistence');
const roomMembershipService = require('gitter-web-rooms/lib/room-membership-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const parseGitterMxid = require('gitter-web-matrix-bridge/lib/parse-gitter-mxid');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');

const configuredServerName = config.get('matrix:bridge:serverName');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE_FOR_ROOMS = 50;
const DB_BATCH_SIZE_FOR_ROOM_MEMBERSHIP = 100;

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of rooms to process at once'
  })
  // Worker index option to only process rooms which evenly divide against that index
  // (partition) (make sure to update the `laneStatusFilePath` to be unique from other
  // workers)
  .option('worker-index', {
    type: 'number',
    description:
      '1-based index of the worker (should be unique across all workers) to only process the subset of rooms where the ID evenly divides (partition). If not set, this should be the only worker across the whole environment.'
  })
  .option('worker-total', {
    type: 'number',
    description:
      'The total number of workers. We will partition based on this number `(id % workerTotal) === workerIndex ? doWork : pass`'
  })
  .help('help')
  .alias('help', 'h').argv;

if (opts.workerIndex && opts.workerIndex <= 0) {
  throw new Error(`opts.workerIndex=${opts.workerIndex} must start at 1`);
}
if (opts.workerIndex && opts.workerIndex > opts.workerTotal) {
  throw new Error(
    `opts.workerIndex=${opts.workerIndex} can not be higher than opts.workerTotal=${opts.workerTotal}`
  );
}

async function syncRoomMembershipForBridgedRoom(bridgedRoomEntry) {
  const gitterRoomId = bridgedRoomEntry.troupeId;
  assert(gitterRoomId);
  const matrixRoomId = bridgedRoomEntry.matrixRoomId;
  assert(matrixRoomId);

  const alreadyJoinedGitterUserIdsToMatrixRoom = {};

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

    const isGitterRoomMember = await roomMembershipService.checkRoomMembership(
      gitterRoomId,
      gitterUserId
    );
    // Save this look-up so we can re-use it below when we loop over
    alreadyJoinedGitterUserIdsToMatrixRoom[gitterUserId] = isGitterRoomMember;

    // Remove from Matrix room if they are no longer part of the room on Gitter
    if (!isGitterRoomMember) {
      const intent = this.matrixBridge.getIntent(mxid);
      // TODO: We might as well leave the "live" room and the historical room at the same time
      await intent.leave(matrixRoomId);
    }
  }

  const gitterMembershipStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ resumeCursorFromId }) => {
      const messageCursor = persistence.TroupeUser.find(
        {
          gitterRoomId
          // Ideally, we would factor in `resumeCursorFromId` here but there isn't an
          // `_id` index for this to be efficient. Instead, we will just get a brand new
          // cursor starting from the beginning and try again.
        },
        { userId: 1 }
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

  // Loop through all members of the Gitter room, add anyone who is not already present.
  for await (const gitterRoomMemberUserId of gitterMembershipStreamIterable) {
    console.log('gitterRoomMemberUserId TODO: is this a user ID?', gitterRoomMemberUserId);
    // We can skip if we already know the Gitter user is joined to the Matrix room from the
    // previous loop
    if (alreadyJoinedGitterUserIdsToMatrixRoom[gitterRoomMemberUserId]) {
      continue;
    }

    // TODO: Join Gitter user to the "live" and historical Matrix room
  }
}

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: bridgedRoomEntry => {
    const matrixRoomId = bridgedRoomEntry.matrixRoomId;
    return matrixRoomId;
  }
});

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const bridgedMatrixRoomCursor = persistence.MatrixBridgedRoom.find({})
    // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
    .cursor();
  const bridgedMatrixRoomStreamIterable = iterableFromMongooseCursor(bridgedMatrixRoomCursor);

  await concurrentQueue.processFromGenerator(
    bridgedMatrixRoomStreamIterable,
    gitterRoom => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // If we're in worker mode, only process a sub-section of the roomID's.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = mongoUtils.splitMongoObjectIdIntoPieces(gitterRoomId);

        const shouldBeProcessedByThisWorker =
          incrementingValue % opts.workerTotal === opts.workerIndex - 1;
        return shouldBeProcessedByThisWorker;
      }

      // TODO: We don't need to process ONE_TO_ONE rooms or Matrix DM rooms since those
      // are always between two people who are sending the messages there. And for
      // Matrix DM's, by their nature have always bridged to Matrix so there is no
      // mismatch.

      return true;
    },
    async ({ value: bridgedRoomEntry /*, laneIndex*/ }) => {
      await syncRoomMembershipForBridgedRoom(bridgedRoomEntry);
    }
  );

  const failedItemIds = concurrentQueue.getFailedItemIds();
  if (failedItemIds.length === 0) {
    logger.info(`Successfully synced membership to all "live" matrix rooms`);
  } else {
    logger.info(
      `Done syncing membership to to all "live" matrix rooms but failed to process ${failedItemIds.length} rooms`
    );
    logger.info(`failedItemIds`, failedItemIds);
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item process failures above).`
    );
  })
  .catch(err => {
    logger.error(
      'Error occurred while syncing membership to to all "live" matrix rooms:',
      err.stack
    );
  })
  .then(() => {
    shutdown.shutdownGracefully();
  });
