#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:matrix-historical-import');

const env = require('gitter-web-env');
const logger = env.logger;
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
// Setup stat logging
require('./gitter-to-matrix-historical-import/performance-observer-stats');

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  // .option('uri', {
  //   alias: 'u',
  //   required: true,
  //   description: 'URI of the Gitter room to backfill'
  // })
  .help('help')
  .alias('help', 'h').argv;

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  await gitterToMatrixHistoricalImport(gitterRoomId);
}

exec()
  .then(() => {
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events for ${opts.uri}:`, err.stack);
    shutdown.shutdownGracefully();
  });
