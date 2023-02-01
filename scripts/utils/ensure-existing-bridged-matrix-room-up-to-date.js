#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/ensure-existing-bridged-matrix-room-up-to-date.js --uri some/room
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/ensure-existing-bridged-matrix-room-up-to-date.js --uri some/room
//
'use strict';

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:ensure-existing-bridged-matrix-room-up-to-date');
const env = require('gitter-web-env');
const logger = env.logger;
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  isGitterRoomIdDoneImporting
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to update'
  })
  .option('keep-existing-user-power-levels', {
    type: 'boolean',
    default: true,
    description: '[0|1] Whether to keep snowflake user power that may already be set on the room.'
  })
  .option('skip-room-avatar-if-exists', {
    type: 'boolean',
    default: true,
    description: `[0|1] Whether to skip the avatar updating step (this option is pretty safe since we only skip if an avatar is already set so it's defaulted to true).`
  })
  .help('help')
  .alias('help', 'h').argv;

if (opts.keepExistingUserPowerLevels) {
  console.log(
    `Note: Keeping existing user power levels around (opts.keepExistingUserPowerLevels=${opts.keepExistingUserPowerLevels}).`
  );
}

async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    try {
      const gitterRoom = await troupeService.findByUri(opts.uri);
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // Find our current live Matrix room
      let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
      // Find the historical Matrix room we should import the history into
      let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
        gitterRoomId
      );
      debug(
        `Found matrixHistoricalRoomId=${matrixHistoricalRoomId} matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
      );

      logger.info(
        `Updating matrixRoomId=${matrixRoomId} and matrixHistoricalRoomId=${matrixHistoricalRoomId} for gitterRoomId=${gitterRoomId}`
      );
      await matrixUtils.ensureCorrectRoomState(matrixRoomId, gitterRoomId, {
        keepExistingUserPowerLevels: opts.keepExistingUserPowerLevels,
        skipRoomAvatarIfExists: opts.skipRoomAvatarIfExists
      });
      if (matrixHistoricalRoomId) {
        const isDoneImporting = await isGitterRoomIdDoneImporting(gitterRoomId);
        if (isDoneImporting) {
          await matrixUtils.ensureCorrectHistoricalMatrixRoomStateAfterImport({
            matrixRoomId,
            matrixHistoricalRoomId,
            gitterRoomId,
            skipRoomAvatarIfExists: opts.skipRoomAvatarIfExists
          });
        } else {
          await matrixUtils.ensureCorrectHistoricalMatrixRoomStateBeforeImport({
            matrixHistoricalRoomId,
            gitterRoomId,
            skipRoomAvatarIfExists: opts.skipRoomAvatarIfExists
          });
        }
      }

      logger.info(
        `Bridged Matrix room updated! matrixRoomId=${matrixRoomId} and matrixHistoricalRoomId=${matrixHistoricalRoomId} for gitterRoomId=${gitterRoomId}`
      );
    } catch (err) {
      logger.error('Failed to update Matrix room', { exception: err });
    }

    // wait 5 seconds to allow for asynchronous `event-listeners` to finish
    // This isn't clean but works
    // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
    // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
    logger.info(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  } catch (err) {
    logger.error('Error occured while updating bridged rooms', { exception: err });
  }
  shutdown.shutdownGracefully();
}

run();
