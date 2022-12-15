#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:reset-matrix-historical-room-bridging');
const readline = require('readline');
const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const { assert } = require('console');

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to reset Matrix bridging status'
  })
  // .option('since-date', {
  //   required: true,
  //   description: 'We will delete all Matrix bridging chat message info from this date backwards'
  // })
  .help('help')
  .alias('help', 'h').argv;

// const sinceTimestamp = Date.parse(opts.sinceDate);
// if (!sinceTimestamp) {
//   throw new Error(
//     `We were unable to understand the given date (${opts.sinceDate}). Try using the format YYYY-MM-DD or YYYY-MM-DDThh:mm:ss.`
//   );
// }

async function resetBridgingingForMatrixHistoricalRoomId(matrixHistoricalRoomId) {
  assert(matrixHistoricalRoomId);
  // Delete bridged chat message entries since the given date in the live room. This is
  // useful when you're testing locally, setup a test room with a bunch of messages, and
  // want to reset to try importing.
  // if (matrixRoomId) {
  //   await persistence.MatrixBridgedChatMessage.remove({
  //     matrixRoomId,
  //     gitterMessageId: { $lt: mongoUtils.createIdForTimestampString(sinceTimestamp) }
  //   }).exec();
  // }
  // Delete all bridged chat message entries in the historical room
  await persistence.MatrixBridgedChatMessage.remove({
    matrixRoomId: matrixHistoricalRoomId
  }).exec();

  // TODO: If ONE_TO_ONE, leave from both sides

  // Shutdown the room so people don't get confused about it
  await matrixUtils.shutdownMatrixRoom(matrixHistoricalRoomId);

  // Delete the historical bridged room entry
  await persistence.MatrixBridgedHistoricalRoom.remove({
    matrixRoomId: matrixHistoricalRoomId
  }).exec();
}

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

  const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(gitterRoomId);
  const matrixHistoricalRoomId = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
    gitterRoomId
  );
  debug(
    `Found matrixHistoricalRoomId=${matrixHistoricalRoomId} (matrixRoomId=${matrixRoomId}) for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  // Ask for confirmation since this does some descructive actions
  await new Promise(function(resolve, reject) {
    rl.question(
      `Are you sure you want to reset Matrix historical bridging data between ${gitterRoom.uri} (${gitterRoomId}) and matrixHistoricalRoomId=${matrixHistoricalRoomId}?`,
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

  await resetBridgingingForMatrixHistoricalRoomId(matrixHistoricalRoomId);
}

exec()
  .then(() => {
    logger.info(`Successfully reset matrix historical room for ${opts.uri}`);
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error('Error occurred while resetting matrix historical room bridging:', err.stack);
    shutdown.shutdownGracefully();
  });
