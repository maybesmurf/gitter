#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const fs = require('fs').promises;
const path = require('path');
const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const LRU = require('lru-cache');
const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const installBridge = require('gitter-web-matrix-bridge');
const {
  gitterToMatrixHistoricalImport,
  matrixHistoricalImportEvents
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
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

const debugConcurrentQueue = require('debug')('gitter:scripts-debug:concurrent-queue');
async function concurrentQueue(itemGenerator, concurrency, asyncProcesssorTask) {
  assert(itemGenerator);
  assert(concurrency);
  assert(asyncProcesssorTask);

  // There will be N lanes to process things in
  const lanes = Array.from(Array(concurrency));

  const laneDonePromises = lanes.map(async (_, laneIndex) => {
    let isGeneratorDone = false;
    while (
      !isGeneratorDone &&
      // An escape hatch in case our generator is doing something unexpected. For example, we should
      // never see null/undefined here. Maybe we forgot to await the next item;
      typeof isGeneratorDone === 'boolean'
    ) {
      const nextItem = await itemGenerator.next();
      const { value, done } = nextItem;
      isGeneratorDone = done;
      if (typeof isGeneratorDone !== 'boolean') {
        debugConcurrentQueue(
          `concurrentQueue: laneIndex=${laneIndex} encountered a bad item where done=${done}, nextItem=${nextItem}`
        );
      }

      if (value) {
        debugConcurrentQueue(
          `concurrentQueue: laneIndex=${laneIndex} picking up value=${value} (${JSON.stringify(
            value
          )})`
        );
        await asyncProcesssorTask({ value, laneIndex });
      }

      if (done) {
        debugConcurrentQueue(`concurrentQueue: laneIndex=${laneIndex} is done`);
      }
    }
  });

  // Wait for all of the lanes to finish
  await Promise.all(laneDonePromises);
}

const laneStatusInfo = {};

// Since this process is meant to be very long-running, prevent it from growing forever
// as we only need to keep track of the rooms currently being processed. We double it
// just to account for a tiny bit of overlap while things are transitioning.
const gitterRoomIdToLaneIndexCache = LRU({
  max: 2 * opts.concurrency
});

const laneStatusFilePath = path.resolve(
  __dirname,
  './gitter-to-matrix-historical-import/_lane-worker-status-data.json'
);
let writingStatusInfoLock;
async function writeStatusInfo() {
  // Prevent multiple writes from building up. We only allow one write every 0.5 seconds
  // until it finishes
  if (writingStatusInfoLock) {
    return;
  }

  writingStatusInfoLock = true;
  await fs.writeFile(laneStatusFilePath, JSON.stringify(laneStatusInfo));
  writingStatusInfoLock = false;
}
// Write every 0.5 seconds
const writeStatusInfoIntervalId = setInterval(writeStatusInfo, 500);

matrixHistoricalImportEvents.on('eventImported', ({ gitterRoomId, count }) => {
  assert(gitterRoomId);
  assert(Number.isSafeInteger(count));

  const laneIndex = gitterRoomIdToLaneIndexCache.get(String(gitterRoomId));
  // We don't know the lane for this room, just bail
  if (!laneIndex) {
    return;
  }

  // The lane isn't working on this room anymore, bail
  if (laneStatusInfo[laneIndex].gitterRoom.id !== gitterRoomId) {
    return;
  }

  laneStatusInfo[laneIndex].numMessagesImported += count;
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

  await concurrentQueue(
    gitterRoomStreamIterable,
    opts.concurrency,
    async ({ value: gitterRoom, laneIndex }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // TODO: Make sure failure in one room doesn't stop the whole queue, just keep
      // moving on and log the failure. Maybe some safety if they all start failing.

      // Track some meta info so we can display a nice UI around what's happening
      gitterRoomIdToLaneIndexCache.set(String(gitterRoomId), laneIndex);
      const numTotalMessagesInRoom = await mongooseUtils.getEstimatedCountForId(
        persistence.ChatMessage,
        'toTroupeId',
        gitterRoomId,
        { read: true }
      );
      laneStatusInfo[laneIndex] = {
        gitterRoom: {
          id: gitterRoomId,
          uri: gitterRoom.uri,
          lcUri: gitterRoom.lcUri
        },
        numMessagesImported: 0,
        numTotalMessagesInRoom
      };

      await gitterToMatrixHistoricalImport(gitterRoomId);

      // Dummy load for lanes
      //
      // await new Promise(resolve => {
      //   setTimeout(resolve, Math.random() * 5000);
      // });
    }
  );

  logger.info(`Successfully imported all historical messages for all rooms`);
}

exec()
  .then(() => {
    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events:`, err.stack);
    shutdown.shutdownGracefully();
  })
  .then(() => {
    // Stop writing the status file so we can also cleanly exit
    clearInterval(writeStatusInfoIntervalId);
  });
