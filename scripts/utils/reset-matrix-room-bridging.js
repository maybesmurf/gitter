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

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to reset Matrix bridging status'
  })
  .help('help')
  .alias('help', 'h').argv;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
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

  // Delete the canonical primary alias from the room directory (and whatever aliases were set)
  await matrixUtils.deleteRoomAliasesForMatrixRoomId(matrixRoomId);

  // Delete bridged chat message entries since the given date
  await persistence.MatrixBridgedChatMessage.remove({
    matrixRoomId
  }).exec();

  // Shutdown the room so people don't get confused about it
  await matrixUtils.shutdownMatrixRoom(matrixRoomId);

  // Delete the bridged room entry
  await persistence.MatrixBridgedRoom.remove({
    matrixRoomId
  }).exec();
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
