#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/ensure-existing-bridged-matrix-rooms-up-to-date.js
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/ensure-existing-bridged-matrix-rooms-up-to-date.js
//
'use strict';

const debug = require('debug')('gitter:scripts:ensure-existing-bridged-matrix-rooms-up-to-date');
const shutdown = require('shutdown');
const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const persistence = require('gitter-web-persistence');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  isGitterRoomIdDoneImporting
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE_FOR_ROOMS = 50;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of rooms to process at once'
  })
  // Worker index option to only process rooms which evenly divide against that index
  // (partition) (make sure to update the `laneStatusFilePath` to be unique from other
  // workers)
  .option('worker-index', {
    type: 'number',
    description:
      '1-based index of the worker (should be unique across all workers) to only process the subset of rooms where the ID evenly divides (partition). If not set, this should be the only worker across the whole environment.'
  })
  .option('worker-total', {
    type: 'number',
    description:
      'The total number of workers. We will partition based on this number `(id % workerTotal) === workerIndex ? doWork : pass`'
  })
  .option('resume-from-gitter-room-id', {
    description: 'The Gitter room ID to resume the update process from'
  })
  .option('delay', {
    alias: 'd',
    type: 'number',
    required: true,
    default: 2000,
    description:
      'Delay timeout(in milliseconds) between rooms to update to not overwhelm the homeserver'
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

let numberOfRoomsAttemptedToUpdate = 0;
let numberOfRoomsUpdatedSuccessfully = 0;

if (opts.keepExistingUserPowerLevels) {
  logger.info(
    `Note: Keeping existing user power levels around (opts.keepExistingUserPowerLevels=${opts.keepExistingUserPowerLevels}).`
  );
}

if (opts.workerIndex && opts.workerIndex <= 0) {
  throw new Error(`opts.workerIndex=${opts.workerIndex} must start at 1`);
}
if (opts.workerIndex && opts.workerIndex > opts.workerTotal) {
  throw new Error(
    `opts.workerIndex=${opts.workerIndex} can not be higher than opts.workerTotal=${opts.workerTotal}`
  );
}

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: gitterRoom => {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;
    return String(gitterRoomId);
  }
});

async function updateAllRooms() {
  const resumeFromGitterRoomId = opts.resumeFromGitterRoomId;
  if (resumeFromGitterRoomId) {
    logger.info(`Resuming from resumeFromGitterRoomId=${resumeFromGitterRoomId}`);
  }

  const gitterRoomStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      const gitterRoomCursor = persistence.Troupe.find({
        _id: (() => {
          const idQuery = {};

          if (previousIdFromCursor) {
            idQuery['$gt'] = previousIdFromCursor;
          } else if (resumeFromGitterRoomId) {
            idQuery['$gte'] = resumeFromGitterRoomId;
          } else {
            idQuery['$exists'] = true;
          }

          return idQuery;
        })()
      })
        // Go from oldest to most recent because the bulk of the history will be in the oldest rooms
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_ROOMS)
        .cursor();

      return { cursor: gitterRoomCursor, batchSize: DB_BATCH_SIZE_FOR_ROOMS };
    }
  );

  await concurrentQueue.processFromGenerator(
    gitterRoomStreamIterable,
    // Room filter
    gitterRoom => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;

      // Skip any ONE_TO_ONE rooms because one to one rooms are setup correctly from the
      // beginning and never need updates
      if (gitterRoom.sd.type === 'ONE_TO_ONE') {
        return false;
      }

      // If we're in worker mode, only process a sub-section of the roomID's.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = mongoUtils.splitMongoObjectIdIntoPieces(gitterRoomId);

        const shouldBeProcessedByThisWorker =
          incrementingValue % opts.workerTotal === opts.workerIndex - 1;
        return shouldBeProcessedByThisWorker;
      }

      return true;
    },
    // Process function
    async ({ value: gitterRoom /*, laneIndex*/ }) => {
      numberOfRoomsAttemptedToUpdate += 1;
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

      try {
        logger.info(
          `Updating matrixRoomId=${matrixRoomId} and matrixHistoricalRoomId=${matrixHistoricalRoomId} for gitterRoomId=${gitterRoomId} (${gitterRoom.uri})`
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
        numberOfRoomsUpdatedSuccessfully += 1;
      } catch (err) {
        logger.error(
          `Failed to update matrixRoomId=${matrixRoomId} or matrixHistoricalRoomId=${matrixHistoricalRoomId} from gitterRoomId=${gitterRoomId}`,
          { exception: err }
        );
        throw err;
      } finally {
        // Put a delay between each time we process and update a bridged room
        // to avoid overwhelming and hitting the rate-limits on the Matrix homeserver
        if (opts.delay > 0) {
          await new Promise(resolve => {
            setTimeout(resolve, opts.delay);
          });
        }
      }
    }
  );
}

async function run() {
  try {
    logger.info('Setting up Matrix bridge');
    await installBridge();

    logger.info('Starting to update all bridged rooms');
    await updateAllRooms();
    logger.info(
      `${numberOfRoomsUpdatedSuccessfully}/${numberOfRoomsAttemptedToUpdate} bridged matrix rooms updated successfully!`
    );

    const failedRoomIds = concurrentQueue.getFailedItemIds();
    if (failedRoomIds.length === 0) {
      logger.info(
        `Successfully updated all rooms ${numberOfRoomsUpdatedSuccessfully}/${numberOfRoomsAttemptedToUpdate}`
      );
    } else {
      logger.info(
        `Done updating rooms (${numberOfRoomsAttemptedToUpdate} rooms) but failed to process ${failedRoomIds.length} rooms`
      );
      logger.info(`failedRoomIds`, failedRoomIds);
      const failedRoomInfos = await troupeService.findByIdsLean(failedRoomIds, { uri: 1 });
      logger.info(
        `failedRoomInfos`,
        // A poor-mans `JSON.stringify` that compacts the output of each item to a single
        // line
        `{\n`,
        failedRoomInfos
          .map((failedRoomInfo, index) => {
            return `  "${index}": ${JSON.stringify({
              id: failedRoomInfo.id || failedRoomInfo._id,
              uri: failedRoomInfo.uri
            })}`;
          })
          .join('\n'),
        `\n}`
      );
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
