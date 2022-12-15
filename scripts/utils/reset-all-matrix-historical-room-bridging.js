#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:reset-all-matrix-historical-room-bridging');
const readline = require('readline');
const env = require('gitter-web-env');
const logger = env.logger;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
const { assert } = require('console');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE_FOR_ROOMS = 50;

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of rooms to process at once'
  })
  .help('help')
  .alias('help', 'h').argv;

async function resetBridgingingForMatrixHistoricalRoomId(bridgedHistoricalRoomEntry) {
  const matrixHistoricalRoomId = bridgedHistoricalRoomEntry.matrixRoomId;
  assert(matrixHistoricalRoomId);

  // Delete all bridged chat message entries in the historical room
  await persistence.MatrixBridgedChatMessage.remove({
    matrixRoomId: matrixHistoricalRoomId
  }).exec();

  // Shutdown the room so people don't get confused about it
  await matrixUtils.shutdownMatrixRoom(matrixHistoricalRoomId);

  // Delete the historical bridged room entry
  await persistence.MatrixBridgedHistoricalRoom.remove({
    matrixRoomId: matrixHistoricalRoomId
  }).exec();
}

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: bridgedRoomEntry => {
    const matrixRoomId = bridgedRoomEntry.matrixRoomId;
    return matrixRoomId;
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  // Ask for confirmation since this does some descructive actions
  await new Promise(function(resolve, reject) {
    rl.question(`Are you sure you want to reset Matrix historical bridging data?`, function(
      answer
    ) {
      rl.close();
      console.log(answer);

      if (answer === 'yes') {
        resolve();
      } else {
        reject(new Error('Answered no'));
      }
    });
  });

  const bridgedHistoricalMatrixRoomCursor = persistence.MatrixBridgedHistoricalRoom.find({})
    // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
    .cursor();
  const bridgedHistoricalMatrixRoomStreamIterable = iterableFromMongooseCursor(
    bridgedHistoricalMatrixRoomCursor
  );

  await concurrentQueue.processFromGenerator(
    bridgedHistoricalMatrixRoomStreamIterable,
    async ({ value: bridgedHistoricalRoomEntry, laneIndex }) => {
      await resetBridgingingForMatrixHistoricalRoomId(bridgedHistoricalRoomEntry);
    }
  );

  const failedItemIds = concurrentQueue.getFailedItemIds();
  if (failedItemIds.length === 0) {
    logger.info(`Successfully reset all matrix historical room bridging`);
  } else {
    logger.info(
      `Done resetting  all matrix historical room bridging but failed to process ${failedItemIds.length} rooms`
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
    logger.error('Error occurred while resetting matrix historical room bridging:', err.stack);
  })
  .then(() => {
    shutdown.shutdownGracefully();
  });
