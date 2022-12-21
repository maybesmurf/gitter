#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:reset-matrix-room-bridging');
const readline = require('readline');
const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const { assert } = require('console');

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('id', {
    description: 'ID of the Gitter room to reset Matrix bridging status'
  })
  .option('uri', {
    alias: 'u',
    description: 'URI of the Gitter room to reset Matrix bridging status'
  })
  .help('help')
  .alias('help', 'h').argv;

if (!opts.id && !opts.uri) {
  throw new Error('--id or --uri are required');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// eslint-disable-next-line max-statements
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
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  debug(
    `Found matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  // Ask for confirmation since this does some descructive actions
  await new Promise(function(resolve, reject) {
    rl.question(
      `Are you sure you want to reset Matrix bridging data between ${gitterRoom.uri} (${gitterRoomId}) and ${matrixRoomId}?`,
      function(answer) {
        rl.close();
        console.log(answer);

        if (answer === 'yes') {
          resolve();
        } else {
          reject(new Error('Answered no'));
        }
      }
    );
  });

  if (!gitterRoom.oneToOne) {
    // Delete the canonical primary alias from the room directory (and whatever aliases were set)
    await matrixUtils.deleteRoomAliasesForMatrixRoomId(matrixRoomId);
    console.log(`Removed room aliases for matrixRoomId=${matrixRoomId}`);
  }

  // Delete bridged chat message entries since the given date
  await persistence.MatrixBridgedChatMessage.remove({
    matrixRoomId
  }).exec();
  console.log(`Removed bridged chat messages in matrixRoomId=${matrixRoomId}`);

  // Shutdown the room so people don't get confused about it
  await matrixUtils.shutdownMatrixRoom(matrixRoomId);
  console.log(`Shut down room matrixRoomId=${matrixRoomId}`);

  // Delete the bridged room entry
  await persistence.MatrixBridgedRoom.remove({
    matrixRoomId
  }).exec();
  console.log(`Remove bridged room entry for matrixRoomId=${matrixRoomId}`);
}

exec()
  .then(() => {
    logger.info(`Successfully reset matrix room bridging for ${opts.uri}`);
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error('Error occurred while resetting matrix room bridging:', err.stack);
    shutdown.shutdownGracefully();
  });
