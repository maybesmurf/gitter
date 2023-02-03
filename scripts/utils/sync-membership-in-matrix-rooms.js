#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('fs').promises;
//const debug = require('debug')('gitter:scripts:reset-all-matrix-historical-room-bridging');

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const groupService = require('gitter-web-groups');

const installBridge = require('gitter-web-matrix-bridge');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
const {
  getRoomIdResumePositionFromFile,
  occasionallyPersistRoomResumePositionCheckpointFileToDisk
} = require('./gitter-to-matrix-historical-import/resume-position-utils');
const {
  syncMatrixRoomMembershipFromGitterRoom
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-room-membership-sync');

const DB_BATCH_SIZE_FOR_ROOMS = 50;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;

// Every N milliseconds (5 minutes), we should track which room we should resume from if
// the import function errors out.
const CALCULATE_ROOM_RESUME_POSITION_TIME_INTERVAL = 5 * 60 * 1000;

// Every N milliseconds (5 minutes), we should record which rooms have failed to import so far
const RECORD_FAILED_ROOMS_TIME_INTERVAL = 5 * 60 * 1000;

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
  .option('uri-deny-pattern', {
    type: 'string',
    required: false,
    description: 'The regex filter to match against the room lcUri'
  })
  .help('help')
  .alias('help', 'h').argv;

const roomUriDenyFilterRegex = opts.uriDenyPattern ? new RegExp(opts.uriDenyPattern, 'i') : null;

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

const tempDirectory = path.join(os.tmpdir(), 'gitter-to-matrix-membership-sync');
mkdirp.sync(tempDirectory);

const roomResumePositionCheckpointFilePath = path.join(
  tempDirectory,
  `./_room-resume-position-checkpoint-${opts.workerIndex || ''}-${opts.workerTotal || ''}.json`
);
logger.info(
  `Writing to roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`
);
const calculateWhichRoomToResumeFromIntervalId = occasionallyPersistRoomResumePositionCheckpointFileToDisk(
  {
    concurrentQueue,
    roomResumePositionCheckpointFilePath,
    persistToDiskIntervalMs: CALCULATE_ROOM_RESUME_POSITION_TIME_INTERVAL
  }
);

const failedRoomIdsFilePath = path.join(tempDirectory, `./_failed-room-ids-${Date.now()}.json`);
async function persistFailedRoomIds(failedRoomIds) {
  const failedRoomIdsToPersist = failedRoomIds || [];

  try {
    logger.info(
      `Writing failedRoomIds (${failedRoomIdsToPersist.length}) disk failedRoomIdsFilePath=${failedRoomIdsFilePath}`
    );
    await fs.writeFile(failedRoomIdsFilePath, JSON.stringify(failedRoomIdsToPersist));
  } catch (err) {
    logger.error(`Problem persisting failedRoomIds file to disk`, { exception: err });
  }
}

let writingFailedRoomsFileLock;
const recordFailedRoomsIntervalId = setInterval(async () => {
  // Prevent multiple writes from building up. We only allow one write until it finishes
  if (writingFailedRoomsFileLock) {
    return;
  }

  try {
    writingFailedRoomsFileLock = true;
    const failedRoomIds = concurrentQueue.getFailedItemIds();
    await persistFailedRoomIds(failedRoomIds);
  } catch (err) {
    logger.error(`Problem persisting failedRoomIds file to disk (from the interval)`, {
      exception: err
    });
  } finally {
    writingFailedRoomsFileLock = false;
  }
}, RECORD_FAILED_ROOMS_TIME_INTERVAL);

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const matrixDmGroupUri = 'matrix';
  const matrixDmGroup = await groupService.findByUri(matrixDmGroupUri, { lean: true });

  const resumeFromGitterRoomId = await getRoomIdResumePositionFromFile(
    roomResumePositionCheckpointFilePath
  );
  if (resumeFromGitterRoomId) {
    logger.info(`Resuming from resumeFromGitterRoomId=${resumeFromGitterRoomId}`);
  }

  const bridgedMatrixRoomStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      const gitterRoomCursor = persistence.Troupe.find({
        _id: (() => {
          const idQuery = {};

          if (previousIdFromCursor) {
            idQuery['$gt'] = previousIdFromCursor;
          } else if (resumeFromGitterRoomId) {
            idQuery['$gte'] = resumeFromGitterRoomId;
          } else {
            idQuery['$exists'] = true;
          }

          return idQuery;
        })()
      })
        // Just use a consistent sort and it makes ascending makes sense to use with `$gt` resuming
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
        .cursor();

      return { cursor: gitterRoomCursor, batchSize: DB_BATCH_SIZE_FOR_ROOMS };
    }
  );

  let numberOfRoomsProcessed = 0;
  await concurrentQueue.processFromGenerator(
    bridgedMatrixRoomStreamIterable,
    gitterRoom => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // We should *not* process any room that matches this room URI deny filter,
      if (roomUriDenyFilterRegex) {
        // A ONE_TO_ONE room won't have a `lcUri` so we need to protect against that.
        const didMatchDenyRegex =
          gitterRoom.lcUri && gitterRoom.lcUri.match(roomUriDenyFilterRegex);
        if (didMatchDenyRegex) {
          return false;
        }
        // Otherwise fall-through to the next filter
      }

      // We don't need to process ONE_TO_ONE rooms since they are always between two
      // people who are sending the messages there.
      if (gitterRoom.oneToOne) {
        return false;
      }

      // Ignore Matrix DMs, rooms under the matrix/ group (matrixDmGroupUri). By their
      // nature, they have been around since the Matrix bridge so there is nothing to
      // import.
      if (
        matrixDmGroup &&
        mongoUtils.objectIDsEqual(gitterRoom.groupId, matrixDmGroup.id || matrixDmGroup._id)
      ) {
        return false;
      }

      // TODO: Add option to only handle non-public rooms where room membership really matters

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

      return true;
    },
    async ({ value: gitterRoom, laneIndex }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      numberOfRoomsProcessed++;
      if (numberOfRoomsProcessed % 100 === 0) {
        logger.info(`Working on gitterRoomId=${gitterRoomId} (${gitterRoom.uri})`);
      }

      concurrentQueue.updateLaneStatus(laneIndex, {
        startTs: Date.now(),
        gitterRoom: {
          id: gitterRoomId,
          uri: gitterRoom.uri,
          lcUri: gitterRoom.lcUri
        }
      });

      await syncMatrixRoomMembershipFromGitterRoom(gitterRoom);
    }
  );

  const failedRoomIds = concurrentQueue.getFailedItemIds();
  // Persist this even if no rooms failed so it's easy to tell whether or not we
  // succeeded in writing anything out. It's better to know nothing failed than whether
  // or not we actually made it to the end.
  await persistFailedRoomIds(failedRoomIds);
  if (failedRoomIds.length === 0) {
    logger.info(`Successfully synced membership to all matrix rooms`);
  } else {
    logger.info(
      `Done syncing membership to to all matrix rooms but failed to process ${failedRoomIds.length} rooms`
    );
    logger.info(`failedRoomIds`, failedRoomIds);
    const failedRoomInfos = await troupeService.findByIdsLean(failedRoomIds, { uri: 1 });
    logger.info(
      `failedRoomInfos`,
      // A poor-mans `JSON.stringify` that compacts the output of each item to a single
      // line
      `{\n`,
      failedRoomInfos
        .map((failedRoomInfo, index) => {
          return `  "${index}": ${JSON.stringify({
            id: failedRoomInfo.id || failedRoomInfo._id,
            uri: failedRoomInfo.uri
          })}`;
        })
        .join('\n'),
      `\n}`
    );
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item process failures above).`
    );
  })
  .catch(err => {
    logger.error('Error occurred while syncing membership to to all matrix rooms:', err.stack);
  })
  .then(() => {
    // Stop calculating which room to resume from as the process is stopping and we
    // don't need to keep track anymore.
    clearInterval(calculateWhichRoomToResumeFromIntervalId);
    // Stop recording failed rooms as we're done doing anything and the process is stopping
    clearInterval(recordFailedRoomsIntervalId);

    shutdown.shutdownGracefully();
  });