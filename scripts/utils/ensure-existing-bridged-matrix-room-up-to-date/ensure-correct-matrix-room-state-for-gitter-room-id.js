'use strict';

const assert = require('assert');
const debug = require('debug')('gitter:scripts:ensure-existing-bridged-matrix-room-up-to-date');

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;

const troupeService = require('gitter-web-rooms/lib/troupe-service');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  isGitterRoomIdDoneImporting
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');

const configuredServerName = config.get('matrix:bridge:serverName');

const matrixUtils = new MatrixUtils(matrixBridge);

// eslint-disable-next-line complexity, max-statements
async function ensureCorrectMatrixRoomStateForGitterRoomId(
  gitterRoomId,
  { keepExistingUserPowerLevels, skipRoomAvatarIfExists }
) {
  assert(gitterRoomId);

  const gitterRoom = await troupeService.findById(gitterRoomId);
  assert(gitterRoom);

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
        skipRoomAvatarIfExists: skipRoomAvatarIfExists
      });
    } else {
      await matrixUtils.ensureCorrectHistoricalMatrixRoomStateBeforeImport({
        matrixHistoricalRoomId,
        gitterRoomId,
        skipRoomAvatarIfExists: skipRoomAvatarIfExists
      });
    }
  }

  try {
    // Then handle the "live" Matrix room which may fail because we don't control
    // the room in all cases
    await matrixUtils.ensureCorrectRoomState(matrixRoomId, gitterRoomId, {
      keepExistingUserPowerLevels: keepExistingUserPowerLevels,
      skipRoomAvatarIfExists: skipRoomAvatarIfExists
    });
  } catch (err) {
    const [, serverName] = matrixRoomId.split(':') || [];
    const isForbiddenError = err.body && err.body.errcode === `M_FORBIDDEN`;
    // This is very bad and hacky but `matrix-appservice-bridge` gives us no other
    // clues of this specific problem, see
    // https://github.com/matrix-org/matrix-appservice-bridge/blob/78c1ed201233fc81ff9e1021f2bccfdca95f337b/src/components/intent.ts#L1113-L1118
    const isHackyForbiddenError =
      err.message && err.message.startsWith('Cannot ensure client has power level for event');
    if (serverName !== configuredServerName && (isForbiddenError || isHackyForbiddenError)) {
      logger.warn(
        `Unable to update matrixRoomId=${matrixRoomId} (bridged to gitterRoomId=${gitterRoomId}) because we don't have permission in that room. Since this room is bridged to a non-gitter.im room, we can't do anything more to help it.`,
        {
          exception: err
        }
      );
    } else {
      throw err;
    }
  }
}

module.exports = ensureCorrectMatrixRoomStateForGitterRoomId;
