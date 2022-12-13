#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
// Setup stat logging
require('./gitter-to-matrix-historical-import/performance-observer-stats');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE = 10;

const opts = require('yargs')
  // .option('uri', {
  //   alias: 'u',
  //   required: true,
  //   description: 'URI of the Gitter room to backfill'
  // })
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
        debugConcurrentQueue(`concurrentQueue: laneIndex=${laneIndex} picking up value=${value}`);
        await asyncProcesssorTask(value);
      }

      if (done) {
        debugConcurrentQueue(`concurrentQueue: laneIndex=${laneIndex} is done`);
      }
    }
  });

  // Wait for all of the lanes to finish
  await Promise.all(laneDonePromises);
}

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoomCursor = persistence.Troupe.find({})
    // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE)
    .cursor();
  const gitterRoomStreamIterable = iterableFromMongooseCursor(gitterRoomCursor);

  await concurrentQueue(gitterRoomStreamIterable, 3, async gitterRoom => {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;

    //await gitterToMatrixHistoricalImport(gitterRoomId);
    await new Promise(resolve => {
      setTimeout(resolve, Math.random() * 5000);
    });
  });

  logger.info(`Successfully imported all historical messages for all rooms`);
}

exec()
  .then(() => {
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events for ${opts.uri}:`, err.stack);
    shutdown.shutdownGracefully();
  });
