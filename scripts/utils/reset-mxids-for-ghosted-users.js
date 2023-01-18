#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:reset-mxids-for-ghosted-users');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');

const DB_BATCH_SIZE_FOR_USERS = 256;

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of users to process at once'
  })
  .option('resume-from-gitter-user-id', {
    type: 'string',
    description:
      'The Gitter user ID to start the reset from. Otherwise will reset all ghost users available in the database.'
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

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: gitterRoom => {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;
    return String(gitterRoomId);
  }
});

let stopBridge;
// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  stopBridge = await installBridge();

  const gitterUserStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      const gitterUserCursor = persistence.User.find({
        _id: (() => {
          const idQuery = {};

          const lastIdThatWasProcessed =
            previousIdFromCursor ||
            // Resume position to start the process again
            opts.resumeFromGitterUserId;
          if (lastIdThatWasProcessed) {
            idQuery['$gt'] = lastIdThatWasProcessed;
          } else {
            idQuery['$exists'] = true;
          }

          return idQuery;
        })()
      })
        // Go from oldest to most recent (no reason, we just need a consistent
        // direction). We probably will find more ghosted users the longer someone's
        // account has been around 🤷
        .sort({ _id: 'asc' })
        .lean()
        .read(mongoReadPrefs.secondaryPreferred)
        .batchSize(DB_BATCH_SIZE_FOR_USERS)
        .cursor();

      return { cursor: gitterUserCursor, batchSize: DB_BATCH_SIZE_FOR_USERS };
    }
  );

  let numberOfGhostedUsers = 0;
  await concurrentQueue.processFromGenerator(
    gitterUserStreamIterable,
    // User filter
    gitterUser => {
      const gitterUserId = gitterUser.id || gitterUser._id;

      // We only want to process problem users with a tilde (`~`) in their username like
      // ghosted users, `ghost~123` or `removed~123` because it gets escaped as `=7e`
      // and our expectation vs the bridge is misaligned.
      if (!gitterUser.username.includes('~')) {
        return false;
      }

      // If we're in worker mode, only process a sub-section of the roomID's.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = mongoUtils.splitMongoObjectIdIntoPieces(gitterUserId);

        const shouldBeProcessedByThisWorker =
          incrementingValue % opts.workerTotal === opts.workerIndex - 1;
        return shouldBeProcessedByThisWorker;
      }

      return true;
    },
    // Process function
    async ({ value: gitterUser /*, laneIndex */ }) => {
      numberOfGhostedUsers++;
      const gitterUserId = gitterUser.id || gitterUser._id;

      // Remove our old stored entry for this Gitter user. It's "corrupted" with escaped
      // characters (the `~` converted to `=7e`) and is mis-aligned with what we expect
      // the MXID should be nowadays.
      await persistence.MatrixBridgedUser.remove({
        userId: gitterUserId
      }).exec();

      // Re-create the MXID
      const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);
      debug('New MXID for ghost', gitterUserMxid);
    }
  );

  const failedItemIds = concurrentQueue.getFailedItemIds();
  if (failedItemIds.length === 0) {
    logger.info(
      `Successfully reset MXIDs for ghosted users with no errors (${numberOfGhostedUsers} users)`
    );
  } else {
    logger.info(
      `Done reset MXIDs for ghosted users but failed to process ${failedItemIds.length} users (out of ${numberOfGhostedUsers} users)`
    );
    logger.info(JSON.stringify(failedItemIds));
  }
}

exec()
  .then(() => {
    logger.info(`Script finished without an error (check for individual item failures above).`);
  })
  .catch(err => {
    logger.error(
      `Error occurred while running through the process of reset MXIDs for ghosted users:`,
      err.stack
    );
  })
  .then(async () => {
    if (stopBridge) {
      await stopBridge();
    }

    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
