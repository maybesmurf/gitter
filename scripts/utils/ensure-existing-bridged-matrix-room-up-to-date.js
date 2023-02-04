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
const config = env.config;
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  isGitterRoomIdDoneImporting
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');

const configuredServerName = config.get('matrix:bridge:serverName');

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

// eslint-disable-next-line complexity, max-statements
async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    const matrixDmGroupUri = 'matrix';
    const matrixDmGroup = await groupService.findByUri(matrixDmGroupUri, { lean: true });

    try {
      const gitterRoom = await troupeService.findByUri(opts.uri);
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // Skip any Matrix DM's since `ensureCorrectRoomState` should not be used on DM
      // rooms with Matrix users. Also by their nature, they have been around since the
      // Matrix bridge so there is historical room to update either.
      if (
        matrixDmGroup &&
        mongoUtils.objectIDsEqual(gitterRoom.groupId, matrixDmGroup.id || matrixDmGroup._id)
      ) {
        logger.warn(
          `Unable to run \`ensureCorrectRoomState\` on DM rooms with Matrix users so skipping and doing nothing here.`
        );
        return;
      }

      // Find our current live Matrix room
      const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
      // Find the historical Matrix room we should import the history into
      const matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
        gitterRoomId
      );
      debug(
        `Found matrixHistoricalRoomId=${matrixHistoricalRoomId} matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
      );

      logger.info(
        `Updating matrixRoomId=${matrixRoomId} and matrixHistoricalRoomId=${matrixHistoricalRoomId} for gitterRoomId=${gitterRoomId}`
      );

      // Handle the `matrixHistoricalRoomId` first because it's more likely to succeed
      // no matter what given it's a `gitter.im` homeserver room where we have all
      // permissions necessary to do whatever we want
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

      try {
        // Then handle the "live" Matrix room which may fail because we don't control
        // the room in all cases
        await matrixUtils.ensureCorrectRoomState(matrixRoomId, gitterRoomId, {
          keepExistingUserPowerLevels: opts.keepExistingUserPowerLevels,
          skipRoomAvatarIfExists: opts.skipRoomAvatarIfExists
        });
      } catch (err) {
        const [, serverName] = matrixRoomId.split(':') || [];
        if (
          serverName !== configuredServerName &&
          // This is very bad and hacky but `matrix-appservice-bridge` gives us no other clues of this specific problem
          err.message.startsWith('Cannot ensure client has power level for event')
        ) {
          logger.warning(
            `Unable to update matrixRoomId=${matrixRoomId} (bridged to gitterRoomId=${gitterRoomId}) because we don't have permission in that room. Since this room is bridged to a non-gitter.im room, we can't do anything more to help it.`,
            {
              exception: err
            }
          );
        } else {
          throw err;
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
