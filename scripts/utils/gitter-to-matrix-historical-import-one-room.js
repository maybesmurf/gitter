#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
//const debug = require('debug')('gitter:scripts:matrix-historical-import-one-room');

const env = require('gitter-web-env');
const logger = env.logger;
const troupeService = require('gitter-web-rooms/lib/troupe-service');
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
  .option('id', {
    description: 'ID of the Gitter room to reset Matrix bridging status'
  })
  .option('uri', {
    alias: 'u',
    description: 'URI of the Gitter room to backfill'
  })
  .help('help')
  .alias('help', 'h').argv;

if (!opts.id && !opts.uri) {
  throw new Error('--id or --uri are required');
}

// eslint-disable-next-line max-statements
let gitterRoomId;
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  let gitterRoom;
  if (opts.id) {
    gitterRoom = await troupeService.findById(opts.id);
  } else if (opts.uri) {
    gitterRoom = await troupeService.findByUri(opts.uri);
  }
  assert('gitterRoom', `Gitter room not found for opts.id=${opts.id} or opts.uri=${opts.uri}`);
  gitterRoomId = gitterRoom.id || gitterRoom._id;

  // Find our current live Matrix room
  let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );

  logger.info(
    `Starting import script for ${gitterRoom.uri} (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (live matrixRoomId=${matrixRoomId})`
  );

  await gitterToMatrixHistoricalImport(gitterRoomId);

  logger.info(
    `Successfully imported all historical messages for ${opts.uri} to matrixHistoricalRoomId=${matrixHistoricalRoomId}`
  );
}

exec()
  .then(() => {
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    let errorThingToPrint = err.stack;
    // Special case from matrix-appservice-bridge/matrix-bot-sdk
    if (err.body && err.body.errcode && err.toJSON) {
      const serializedRequestAsError = err.toJSON();
      (serializedRequestAsError.request || {}).headers = {
        ...serializedRequestAsError.request.headers,
        Authorization: '<redacted>'
      };
      errorThingToPrint = `matrix-appservice-bridge/matrix-bot-sdk threw an error that looked more like a request object, see ${JSON.stringify(
        serializedRequestAsError
      )}`;
    }

    logger.error(
      `Error occurred while backfilling events for opts.uri=${opts.uri} gitterRoomId=${gitterRoomId}:`,
      errorThingToPrint
    );
    shutdown.shutdownGracefully();
  });
