#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('fs').promises;
//const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  gitterToMatrixHistoricalImport,
  matrixHistoricalImportEventEmitter
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
// Setup stat logging
require('./gitter-to-matrix-historical-import/performance-observer-stats');

// The number of rooms we pull out at once to reduce database roundtrips
const DB_BATCH_SIZE_FOR_ROOMS = 10;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;

logger.info(
  `Using DB_READ_PREFERENCE=${DB_READ_PREFERENCE} to read from MongoDB during this import process`
);

// Every N milliseconds (5 minutes), we should track which room we should resume from if
// the import function errors out.
const CALCULATE_ROOM_RESUME_POSITION_TIME_INTERVAL = 5 * 60 * 1000;

const matrixUtils = new MatrixUtils(matrixBridge);

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
  // If one worker options is set, the other one should be set as well
  .implies('worker-index', 'worker-total')
  .implies('worker-total', 'worker-index')
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

const tempDirectory = path.join(os.tmpdir(), 'gitter-to-matrix-historical-import');
mkdirp.sync(tempDirectory);
const laneStatusFilePath = path.join(
  tempDirectory,
  `./_lane-worker-status-data${opts.workerIndex || ''}.json`
);
logger.info(`Writing to laneStatusFilePath=${laneStatusFilePath}`);
concurrentQueue.continuallyPersistLaneStatusInfoToDisk(laneStatusFilePath);

let eventsImportedRunningTotal = 0;
const debugEventsImported = require('debug')('gitter:scripts-debug:events-imported');
matrixHistoricalImportEventEmitter.on('eventImported', ({ gitterRoomId, count }) => {
  if (!gitterRoomId) {
    debugEventsImported(
      `Unable to associate events imported to lane: gitterRoomId=${gitterRoomId} not defined`
    );
    return;
  }
  if (!Number.isSafeInteger(count)) {
    debugEventsImported(
      `Unable to associate events imported to lane: count=${count} is not a safe integer`
    );
    return;
  }

  // Keep track of the grand total
  eventsImportedRunningTotal += count;
  concurrentQueue.updateLaneStatusOverallAttributes({
    eventsImportedRunningTotal
  });

  const laneIndex = concurrentQueue.findLaneIndexFromItemId(String(gitterRoomId));
  // We don't know the lane for this room, just bail
  if (laneIndex === null || laneIndex === undefined) {
    debugEventsImported(
      `Unable to associate events imported to lane: unknown laneIndex=${laneIndex} gitterRoomId=${gitterRoomId}`
    );
    return;
  }
  const laneStatusInfo = concurrentQueue.getLaneStatus(laneIndex);

  // The lane isn't working on this room anymore, bail
  const laneWorkingOnGitterRoomId = laneStatusInfo.gitterRoom && laneStatusInfo.gitterRoom.id;
  if (!mongoUtils.objectIDsEqual(laneWorkingOnGitterRoomId, gitterRoomId)) {
    debugEventsImported(
      `Unable to associate events imported to lane: lane no longer working on the same room laneWorkingOnGitterRoomId=${laneWorkingOnGitterRoomId} vs gitterRoomId=${gitterRoomId}`
    );
    return;
  }

  concurrentQueue.updateLaneStatus(laneIndex, {
    numMessagesImported: (laneStatusInfo.numMessagesImported || 0) + count
  });
});

const roomResumePositionCheckpointFilePath = path.join(
  tempDirectory,
  `./_room-resume-position-checkpoint-${opts.workerIndex || ''}-${opts.workerTotal || ''}.json`
);
let writingCheckpointFileLock;
// Loop through all of the lanes and find the oldest room ID
const calculateWhichRoomToResumeFromIntervalId = setInterval(async () => {
  // Get a list of room ID's that the queue is currently working on
  const roomIds = [];
  for (let i = 0; i < opts.concurrency; i++) {
    const laneStatusInfo = concurrentQueue.getLaneStatus(i);
    const laneWorkingOnGitterRoomId = laneStatusInfo.gitterRoom && laneStatusInfo.gitterRoom.id;
    if (laneWorkingOnGitterRoomId) {
      roomIds.push(laneWorkingOnGitterRoomId);
    }
  }

  // Sort the list so the oldest room is sorted first
  const chronologicalSortedRoomIds = roomIds.sort((a, b) => {
    const aTimestamp = mongoUtils.getDateFromObjectId(a);
    const bTimestamp = mongoUtils.getDateFromObjectId(b);
    return aTimestamp - bTimestamp;
  });

  // Take the oldest room in the list. We have to be careful and keep this as the oldest
  // room currently being imported. When we resume, we want to make sure we don't skip
  // over a room that has many many messages just because we imported a bunch of small
  // rooms after in other lanes.
  const trackingResumeFromRoomId = chronologicalSortedRoomIds[0];

  // Nothing to resume at yet, skip
  if (!trackingResumeFromRoomId) {
    return;
  }

  // Prevent multiple writes from building up. We only allow one write until it finishes
  if (writingCheckpointFileLock) {
    return;
  }

  const checkpointData = {
    resumeFromRoomId: trackingResumeFromRoomId
  };

  try {
    logger.info(
      `Writing room checkpoint file to disk roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`,
      checkpointData
    );
    writingCheckpointFileLock = true;
    await fs.writeFile(roomResumePositionCheckpointFilePath, JSON.stringify(checkpointData));
  } catch (err) {
    logger.error(`Problem persisting room checkpoint file to disk`, { exception: err });
  } finally {
    writingCheckpointFileLock = false;
  }
}, CALCULATE_ROOM_RESUME_POSITION_TIME_INTERVAL);

async function getRoomIdResumePosition() {
  try {
    logger.info(
      `Trying to read resume information from roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`
    );
    const fileContents = await fs.readFile(roomResumePositionCheckpointFilePath);
    const checkpointData = JSON.parse(fileContents);
    return checkpointData.resumeFromRoomId;
  } catch (err) {
    logger.error(
      `Unable to read roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`,
      {
        exception: err
      }
    );
  }
}

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

const failedRoomInfosFilePath = path.join(tempDirectory, `./_failed-room-infos-${Date.now()}.json`);
async function persistFailedRoomInfos(failedRoomInfos) {
  const failedRoomInfosToPersist = failedRoomInfos || [];

  try {
    logger.info(
      `Writing failedRoomInfos (${failedRoomInfosToPersist.length}) disk failedRoomInfosFilePath=${failedRoomInfosFilePath}`
    );
    await fs.writeFile(failedRoomInfosFilePath, JSON.stringify(failedRoomInfosToPersist));
  } catch (err) {
    logger.error(`Problem persisting failedRoomInfos file to disk`, { exception: err });
  }
}

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const matrixDmGroupUri = 'matrix';
  const matrixDmGroup = await groupService.findByUri(matrixDmGroupUri, { lean: true });

  const resumeFromGitterRoomId = await getRoomIdResumePosition();
  if (resumeFromGitterRoomId) {
    logger.info(`Resuming from resumeFromGitterRoomId=${resumeFromGitterRoomId}`);
  }

  const gitterRoomStreamIterable = noTimeoutIterableFromMongooseCursor(
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
        // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
        .cursor();

      return { cursor: gitterRoomCursor, batchSize: DB_BATCH_SIZE_FOR_ROOMS };
    }
  );

  await concurrentQueue.processFromGenerator(
    gitterRoomStreamIterable,
    // Room filter
    // eslint-disable-next-line complexity
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

      // Ignore Matrix DMs, rooms under the matrix/ group (matrixDmGroupUri). By their
      // nature, they have been around since the Matrix bridge so there is nothing to
      // import.
      if (
        matrixDmGroup &&
        mongoUtils.objectIDsEqual(gitterRoom.groupId, matrixDmGroup.id || matrixDmGroup._id)
      ) {
        return false;
      }

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
    // Process function
    async ({ value: gitterRoom, laneIndex }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // Track some meta info so we can display a nice UI in the dashboard around what's happening
      const numTotalMessagesInRoom =
        (await mongooseUtils.getEstimatedCountForId(
          persistence.ChatMessage,
          'toTroupeId',
          gitterRoomId,
          { read: DB_READ_PREFERENCE }
        )) || 0;
      // Find our current live Matrix room
      let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
      // Find the historical Matrix room we should import the history into
      let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
        gitterRoomId
      );
      const numMessagesImportedAlreadyInLiveRoom =
        (await mongooseUtils.getEstimatedCountForId(
          persistence.MatrixBridgedChatMessage,
          'matrixRoomId',
          matrixRoomId,
          { read: DB_READ_PREFERENCE }
        )) || 0;
      const numMessagesImportedAlreadyInHistoricalRoom =
        (await mongooseUtils.getEstimatedCountForId(
          persistence.MatrixBridgedChatMessage,
          'matrixRoomId',
          matrixHistoricalRoomId,
          { read: DB_READ_PREFERENCE }
        )) || 0;
      concurrentQueue.updateLaneStatus(laneIndex, {
        startTs: Date.now(),
        gitterRoom: {
          id: gitterRoomId,
          uri: gitterRoom.uri,
          lcUri: gitterRoom.lcUri
        },
        numMessagesImported:
          numMessagesImportedAlreadyInLiveRoom + numMessagesImportedAlreadyInHistoricalRoom,
        numTotalMessagesInRoom
      });

      await gitterToMatrixHistoricalImport(gitterRoomId);
    }
  );

  logger.info(
    `Finished looping over all rooms (aprox. ${eventsImportedRunningTotal} messages imported). Please wait a second while we figure out the items that failed (just need to make a big database lookup).`
  );

  const failedRoomIds = concurrentQueue.getFailedItemIds();
  // Persist this even if no rooms failed so it's easy to tell whether or not we
  // succeeded in writing anything out. It's better to know nothing failed than whether
  // or not we actually made it to the end.
  await persistFailedRoomIds(failedRoomIds);
  if (failedRoomIds.length === 0) {
    logger.info(
      `Successfully imported all historical messages for all rooms (aprox. ${eventsImportedRunningTotal} messages)`
    );
  } else {
    logger.info(
      `Done importing all historical messages for all rooms (aprox. ${eventsImportedRunningTotal} messages) but failed to process ${failedRoomIds.length} rooms`
    );
    const failedRoomInfos = await troupeService.findByIdsLean(failedRoomIds, { uri: 1 });
    logger.info(
      `failedRoomIds`,
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
    await persistFailedRoomInfos(failedRoomInfos);
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item process failures above).`
    );
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events:`, err.stack);
  })
  .then(async () => {
    // Stop calculating which room to resume from as the process is stopping and we
    // don't need to keep track anymore.
    clearInterval(calculateWhichRoomToResumeFromIntervalId);

    // Stop writing the status file so we can cleanly exit
    concurrentQueue.stopPersistLaneStatusInfoToDisk();
    // Write one last time so the "finished" status can be reflected on the dasboard
    await concurrentQueue.persistLaneStatusInfoToDisk(laneStatusFilePath);

    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
