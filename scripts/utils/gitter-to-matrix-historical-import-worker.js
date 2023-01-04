#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
//const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  gitterToMatrixHistoricalImport,
  matrixHistoricalImportEventEmitter
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
// Setup stat logging
require('./gitter-to-matrix-historical-import/performance-observer-stats');

// The number of rooms we pull out at once to reduce database roundtrips
const DB_BATCH_SIZE_FOR_ROOMS = 64;

// Every N milliseconds, we should track which room we should resume from if the import
// function errors out.
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
  .option('resume-from-gitter-room-id', {
    type: 'string',
    description: `The Gitter room ID to start the import from. Usually, you probably won't use this option as you probably want to import everything and there is already a resume mechanism in the worker to keep going if the import ever fails.`
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

// Handles numbers bigger than 64-bit
function hexToByteArray(hexInput) {
  // For each hex character, convert it to it's binary form
  const binaryForCharList = hexInput.split('').map(hexChar => {
    const decimalChar = parseInt(hexChar.toUpperCase(), 16);

    if (Number.isNaN(decimalChar)) {
      throw new Error(`Unexpected character ${hexChar} that is not hex`);
    }

    return decimalChar.toString(2).padStart(4, '0');
  });

  // Turn it into one big long binary string
  const binaryString = binaryForCharList.join('');

  // Convert into a byte list
  const byteArray = binaryString.match(/.{8}/g);

  return byteArray;
}

function splitMongoObjectIdIntoPieces(objectId) {
  const stringifiedObjectId = String(objectId);
  // We can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit and we
  // will lose precision
  const byteArray = hexToByteArray(stringifiedObjectId);

  // The 12-byte ObjectId consists of:
  return {
    // A 4-byte timestamp, representing the ObjectId's creation, measured in seconds
    // since the Unix epoch.
    timestampSecondsPiece: parseInt(byteArray.slice(0, 4).join(''), 2),
    // A 5-byte random value generated once per process. This random value is unique to
    // the machine and process.
    randomValuePerProcess: parseInt(byteArray.slice(4, 9).join(''), 2),
    // A 3-byte incrementing counter, initialized to a random value.
    incrementingValue: parseInt(byteArray.slice(9, 12).join(''), 2)
  };
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

// We have to be careful and keep this as the oldest room currently being imported . We
// want to make sure we don't skip over a room that has many many messages just because
// we imported a bunch of small rooms after in other lanes.
let trackingResumeFromRoomId;
// Loop through all of the lanes and find the oldest room ID
const calculateWhichRoomToResumeFromIntervalId = setInterval(() => {
  // Get a list of room ID's that the queue is currently working on
  const roomIds = [];
  for (let i = 0; i < opts.concurrency; i++) {
    const laneStatusInfo = concurrentQueue.getLaneStatus(i);
    const laneWorkingOnGitterRoomId = laneStatusInfo.gitterRoom && laneStatusInfo.gitterRoom.id;
    roomIds.push(laneWorkingOnGitterRoomId);
  }

  // Sort the list so the oldest room is sorted first
  const chronologicalSortedRoomIds = roomIds.sort((a, b) => {
    const aTimestamp = mongoUtils.getDateFromObjectId(a);
    const bTimestamp = mongoUtils.getDateFromObjectId(b);
    return aTimestamp - bTimestamp;
  });

  // Take the oldest event in the list
  trackingResumeFromRoomId = chronologicalSortedRoomIds[0];
}, CALCULATE_ROOM_RESUME_POSITION_TIME_INTERVAL);

async function importMessages({ resumeFromRoomId }) {
  const gitterRoomCursor = persistence.Troupe.find({
    _id: (() => {
      const idQuery = {};
      if (resumeFromRoomId) {
        idQuery['$gt'] = resumeFromRoomId;
      } else {
        idQuery['$exists'] = true;
      }

      return idQuery;
    })()
  })
    // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
    .cursor();
  const gitterRoomStreamIterable = iterableFromMongooseCursor(gitterRoomCursor);

  await concurrentQueue.processFromGenerator(
    gitterRoomStreamIterable,
    // Room filter
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

      // If we're in worker mode, only process a sub-section of the roomID's.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = splitMongoObjectIdIntoPieces(gitterRoomId);

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
      const numTotalMessagesInRoom = await mongooseUtils.getEstimatedCountForId(
        persistence.ChatMessage,
        'toTroupeId',
        gitterRoomId,
        { read: true }
      );
      // Find our current live Matrix room
      let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
      // Find the historical Matrix room we should import the history into
      let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
        gitterRoomId
      );
      const numMessagesImportedAlreadyInLiveRoom = await mongooseUtils.getEstimatedCountForId(
        persistence.MatrixBridgedChatMessage,
        'matrixRoomId',
        matrixRoomId,
        { read: true }
      );
      const numMessagesImportedAlreadyInHistoricalRoom = await mongooseUtils.getEstimatedCountForId(
        persistence.MatrixBridgedChatMessage,
        'matrixRoomId',
        matrixHistoricalRoomId,
        { read: true }
      );
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
  }

  return true;
}

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  let finishedImporting = false;
  while (!finishedImporting) {
    // Keep trying whenever we fail. For example, this could be a `MongoError: Cursor
    // not found, cursor id: 000` where all lanes were busy importing messages for a
    // while and by the time we come back and try to paginate the cursor to find the
    // next room, the cursor is gone.
    try {
      // TODO: Add some abort mechanism for the currently running lanes
      finishedImporting = await importMessages({
        resumeFromRoomId: trackingResumeFromRoomId || opts.resumeFromGitterRoomId
      });
    } catch (err) {
      logger.error('Import process failed', {
        exception: err
      });

      // TODO: Update stat for dashboard
    }
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
