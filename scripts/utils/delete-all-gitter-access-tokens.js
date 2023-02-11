#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('fs').promises;
//const debug = require('debug')('gitter:scripts:invalidate-all-gitter-tokens');

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const persistence = require('gitter-web-persistence');
var oauthService = require('gitter-web-oauth');

const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');
const getRoomIdsFromJsonFile = require('./gitter-to-matrix-historical-import/get-room-ids-from-json-file');
const {
  getRoomIdResumePositionFromFile,
  occasionallyPersistRoomResumePositionCheckpointFileToDisk
} = require('./gitter-to-matrix-historical-import/resume-position-utils');

// Since we're deleting things, let the Mongo hooks run -> events get emitted
require('../../server/event-listeners').install();

const DB_BATCH_SIZE_FOR_TOKENS = 100;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;

// Every N milliseconds (5 minutes), we should track which room we should resume from if
// the import function errors out.
const CALCULATE_TOKEN_RESUME_POSITION_TIME_INTERVAL = 5 * 60 * 1000;

// Every N milliseconds (5 minutes), we should record which rooms have failed to import so far
const RECORD_FAILED_TOKENS_TIME_INTERVAL = 5 * 60 * 1000;

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of tokens to process at once'
  })
  // Worker index option to only process tokens which evenly divide against that index
  // (partition) (make sure to update the `laneStatusFilePath` to be unique from other
  // workers)
  .option('worker-index', {
    type: 'number',
    description:
      '1-based index of the worker (should be unique across all workers) to only process the subset of tokens where the ID evenly divides (partition). If not set, this should be the only worker across the whole environment.'
  })
  .option('worker-total', {
    type: 'number',
    description:
      'The total number of workers. We will partition based on this number `(id % workerTotal) === workerIndex ? doWork : pass`'
  })
  .option('token-ids-from-json-list-file-path', {
    type: 'string',
    description:
      'The optional path where to read the JSON list of Gitter token IDs from ' +
      '(array of strings or array of objects with "id" property). ' +
      'When this option is not provided, will loop through all tokens'
  })
  .help('help')
  .alias('help', 'h').argv;

if (opts.workerIndex && opts.workerIndex <= 0) {
  throw new Error(`opts.workerIndex=${opts.workerIndex} must start at 1`);
}
if (opts.workerIndex && opts.workerIndex > opts.workerTotal) {
  throw new Error(
    `opts.workerIndex=${opts.workerIndex} can not be higher than opts.workerTotal=${opts.workerTotal}`
  );
}

let manualGitterTokensToProcess = getRoomIdsFromJsonFile(opts.tokenIdsFromJsonListFilePath);

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: gitterToken => {
    const gitterTokenId = gitterToken.id || gitterToken._id;
    return String(gitterTokenId);
  }
});

const tempDirectory = path.join(os.tmpdir(), 'gitter-invalidate-tokens');
mkdirp.sync(tempDirectory);

const tokenResumePositionCheckpointFilePath = path.join(
  tempDirectory,
  `./_token-resume-position-checkpoint-${opts.workerIndex || ''}-${opts.workerTotal || ''}.json`
);
logger.info(
  `Writing to tokenResumePositionCheckpointFilePath=${tokenResumePositionCheckpointFilePath}`
);
const calculateWhichTokenToResumeFromIntervalId = occasionallyPersistRoomResumePositionCheckpointFileToDisk(
  {
    concurrentQueue,
    roomResumePositionCheckpointFilePath: tokenResumePositionCheckpointFilePath,
    persistToDiskIntervalMs: CALCULATE_TOKEN_RESUME_POSITION_TIME_INTERVAL
  }
);

const failedTokenIdsFilePath = path.join(tempDirectory, `./_failed-token-ids-${Date.now()}.json`);
async function persistFailedTokenIds(failedTokenIds) {
  const failedTokenIdsToPersist = failedTokenIds || [];

  try {
    logger.info(
      `Writing failedTokenIdsToPersist (${failedTokenIdsToPersist.length}) disk failedTokenIdsFilePath=${failedTokenIdsFilePath}`
    );
    await fs.writeFile(failedTokenIdsFilePath, JSON.stringify(failedTokenIdsToPersist));
  } catch (err) {
    logger.error(`Problem persisting failedTokenIdsToPersist file to disk`, { exception: err });
  }
}

let writingFailedTokensFileLock;
const recordFailedTokensIntervalId = setInterval(async () => {
  // Prevent multiple writes from building up. We only allow one write until it finishes
  if (writingFailedTokensFileLock) {
    return;
  }

  try {
    writingFailedTokensFileLock = true;
    const failedTokenIds = concurrentQueue.getFailedItemIds();
    await persistFailedTokenIds(failedTokenIds);
  } catch (err) {
    logger.error(`Problem persisting failedTokenIds file to disk (from the interval)`, {
      exception: err
    });
  } finally {
    writingFailedTokensFileLock = false;
  }
}, RECORD_FAILED_TOKENS_TIME_INTERVAL);

// eslint-disable-next-line max-statements
async function exec() {
  const resumeFromTokenId = await getRoomIdResumePositionFromFile(
    tokenResumePositionCheckpointFilePath
  );
  if (resumeFromTokenId) {
    logger.info(`Resuming from resumeFromTokenId=${resumeFromTokenId}`);
  }

  let gitterTokenIterableToProcess;
  if (manualGitterTokensToProcess) {
    gitterTokenIterableToProcess = await persistence.OAuthAccessToken.find(
      manualGitterTokensToProcess
    )
      .lean()
      .exec()
      .values();
  } else {
    gitterTokenIterableToProcess = noTimeoutIterableFromMongooseCursor(
      ({ previousIdFromCursor }) => {
        const gitterTokenCursor = persistence.OAuthAccessToken.find({
          _id: (() => {
            const idQuery = {};

            if (previousIdFromCursor) {
              idQuery['$gt'] = previousIdFromCursor;
            } else if (resumeFromTokenId) {
              idQuery['$gte'] = resumeFromTokenId;
            } else {
              idQuery['$exists'] = true;
            }

            return idQuery;
          })()
        })
          // Just use a consistent sort and it makes ascending makes sense to use with `$gt` resuming
          .sort({ _id: 'asc' })
          .lean()
          .read(DB_READ_PREFERENCE)
          .batchSize(DB_BATCH_SIZE_FOR_TOKENS)
          .cursor();

        return { cursor: gitterTokenCursor, batchSize: DB_BATCH_SIZE_FOR_TOKENS };
      }
    );
  }

  let numberOfTokensProcessed = 0;
  await concurrentQueue.processFromGenerator(
    gitterTokenIterableToProcess,
    gitterToken => {
      const gitterTokenId = gitterToken.id || gitterToken._id;

      // If we're in worker mode, only process a sub-section of the tokens.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = mongoUtils.splitMongoObjectIdIntoPieces(gitterTokenId);

        const shouldBeProcessedByThisWorker =
          incrementingValue % opts.workerTotal === opts.workerIndex - 1;
        return shouldBeProcessedByThisWorker;
      }

      return true;
    },
    async ({ value: gitterToken, laneIndex }) => {
      const gitterTokenId = gitterToken.id || gitterToken._id;

      numberOfTokensProcessed++;
      if (numberOfTokensProcessed % 100 === 0) {
        logger.info(`Working on gitterTokenId=${gitterTokenId} (userId=${gitterToken.userId})`);
      }

      // Used from the resume utilities
      concurrentQueue.updateLaneStatus(laneIndex, {
        startTs: Date.now(),
        // This is `gitterRoom` only because
        // `scripts/utils/gitter-to-matrix-historical-import/resume-position-utils.js`
        // has it hard-coded and this is a quick and dirty script.
        gitterRoom: {
          id: gitterTokenId,
          userId: gitterToken.userId
        }
      });

      // Invalidate token
      await oauthService.deleteToken(gitterToken.token);
    }
  );

  const failedTokenIds = concurrentQueue.getFailedItemIds();
  // Persist this even if no tokens failed so it's easy to tell whether or not we
  // succeeded in writing anything out. It's better to know nothing failed than whether
  // or not we actually made it to the end.
  await persistFailedTokenIds(failedTokenIds);
  if (failedTokenIds.length === 0) {
    logger.info(`Successfully invalidted all Gitter tokens`);
  } else {
    logger.info(`Done invalidating tokens but failed to process ${failedTokenIds.length} tokens`);
    logger.info(`failedTokenIds`, failedTokenIds);
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item process failures above).`
    );
  })
  .catch(err => {
    logger.error('Error occurred while invalidating all Gitter tokens:', err.stack);
  })
  .then(() => {
    // Stop calculating which token to resume from as the process is stopping and we
    // don't need to keep track anymore.
    clearInterval(calculateWhichTokenToResumeFromIntervalId);
    // Stop recording failed tokens as we're done doing anything and the process is stopping
    clearInterval(recordFailedTokensIntervalId);

    shutdown.shutdownGracefully();
  });
