#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const path = require('path');
const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const installBridge = require('gitter-web-matrix-bridge');
const {
  gitterToMatrixHistoricalImport,
  matrixHistoricalImportEvents
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
// Setup stat logging
require('./gitter-to-matrix-historical-import/performance-observer-stats');

// The number of rooms we pull out at once to reduce database roundtrips
const DB_BATCH_SIZE_FOR_ROOMS = 10;

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of rooms to process at once'
  })
  // TODO: Add worker index option to only process rooms which evenly divide against
  // that index (partition) (make sure to update the `laneStatusFilePath` to be unique from other
  // workers)
  .help('help')
  .alias('help', 'h').argv;

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: gitterRoom => {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;
    return String(gitterRoomId);
  }
});

const laneStatusFilePath = path.resolve(
  __dirname,
  './gitter-to-matrix-historical-import/_lane-worker-status-data.json'
);
concurrentQueue.continuallyPersistLaneStatusInfoToDisk(laneStatusFilePath);

const debugEventsImported = require('debug')('gitter:scripts-debug:events-imported');
matrixHistoricalImportEvents.on('eventImported', ({ gitterRoomId, count }) => {
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

  const laneIndex = concurrentQueue.findLaneIndexFromItemId(String(gitterRoomId));
  // We don't know the lane for this room, just bail
  if (!laneIndex) {
    debugEventsImported(
      `Unable to associate events imported to lane: unknown laneIndex=${laneIndex}`
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
    ...laneStatusInfo,
    numMessagesImported: (laneStatusInfo.numMessagesImported || 0) + count
  });
});

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoomCursor = persistence.Troupe.find({})
    // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
    .cursor();
  const gitterRoomStreamIterable = iterableFromMongooseCursor(gitterRoomCursor);

  await concurrentQueue.processFromGenerator(
    gitterRoomStreamIterable,
    async ({ value: gitterRoom, laneIndex }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // Track some meta info so we can display a nice UI around what's happening
      const numTotalMessagesInRoom = await mongooseUtils.getEstimatedCountForId(
        persistence.ChatMessage,
        'toTroupeId',
        gitterRoomId,
        { read: true }
      );
      const laneStatusInfo = concurrentQueue.getLaneStatus(laneIndex);
      concurrentQueue.updateLaneStatus(laneIndex, {
        ...laneStatusInfo,
        startTs: Date.now(),
        gitterRoom: {
          id: gitterRoomId,
          uri: gitterRoom.uri,
          lcUri: gitterRoom.lcUri
        },
        numMessagesImported: 0,
        numTotalMessagesInRoom
      });

      await gitterToMatrixHistoricalImport(gitterRoomId);

      // Dummy load for lanes
      //
      // await new Promise(resolve => {
      //   setTimeout(resolve, Math.random() * 5000);
      // });
    }
  );

  const failedItemIds = concurrentQueue.getFailedItemIds();
  if (failedItemIds.length === 0) {
    logger.info(`Successfully imported all historical messages for all rooms`);
  } else {
    logger.info(
      `Done importing all historical messages for all rooms but failed to process ${failedItemIds.length} rooms`
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
    logger.error(`Error occurred while backfilling events:`, err.stack);
  })
  .then(() => {
    // Stop writing the status file so we can cleanly exit
    concurrentQueue.stopPersistLaneStatusInfoToDisk();
    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
