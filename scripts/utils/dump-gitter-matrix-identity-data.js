#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const readline = require('readline');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const { writeFile, appendFile } = require('fs').promises;
//const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const identityService = require('gitter-web-identity');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const ConcurrentQueue = require('./gitter-to-matrix-historical-import/concurrent-queue');

const DB_BATCH_SIZE_FOR_USERS = 256;

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('concurrency', {
    type: 'number',
    required: true,
    description: 'Number of users to process at once'
  })
  .option('resume-from-gitter-user-id', {
    type: 'string',
    description:
      'The Gitter user ID to start the incremental dump from. Otherwise will dump everything available in the database.'
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

const tempDirectory = path.join(os.tmpdir(), 'gitter-matrix-identity-data-dump');
mkdirp.sync(tempDirectory);
const dataDumpFilePath = path.join(
  tempDirectory,
  `./gitter-matrix-identity-data-dump-${opts.workerIndex || ''}-${opts.workerTotal ||
    ''}-${Date.now()}.ndjson`
);
logger.info(`Writing to data dump to dataDumpFilePath=${dataDumpFilePath}`);

async function appendToDataDumpFile(dataList) {
  const ndJsonString =
    dataList
      .map(data => {
        return JSON.stringify(data);
      })
      .join('\n') + '\n';

  return appendFile(dataDumpFilePath, ndJsonString);
}

const concurrentQueue = new ConcurrentQueue({
  concurrency: opts.concurrency,
  itemIdGetterFromItem: gitterRoom => {
    const gitterRoomId = gitterRoom.id || gitterRoom._id;
    return String(gitterRoomId);
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let stopBridge;
// eslint-disable-next-line max-statements
async function exec() {
  // Make sure we can create persist to the disk in the desired location before we start doing anything
  try {
    await writeFile(dataDumpFilePath, '');
  } catch (err) {
    logger.error(
      `Failed to create the data dump file for failed users dataDumpFilePath=${dataDumpFilePath}`
    );
    throw err;
  }

  logger.info('Setting up Matrix bridge');
  stopBridge = await installBridge();

  const gitterUserStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      const gitterUserCursor = persistence.User.find({
        _id: (() => {
          const idQuery = {};

          const lastIdThatWasProcessed =
            previousIdFromCursor ||
            // Resume position to make incremental dump
            opts.resumeFromGitterUserId;
          if (lastIdThatWasProcessed) {
            idQuery['$gt'] = lastIdThatWasProcessed;
          } else {
            idQuery['$exists'] = true;
          }

          return idQuery;
        })()
      })
        // Go from oldest to most recent for a consistent incremental dump
        .sort({ _id: 'asc' })
        .lean()
        .read(mongoReadPrefs.secondaryPreferred)
        .batchSize(DB_BATCH_SIZE_FOR_USERS)
        .cursor();

      return { cursor: gitterUserCursor, batchSize: DB_BATCH_SIZE_FOR_USERS };
    }
  );

  let runningDataList = [];
  await concurrentQueue.processFromGenerator(
    gitterUserStreamIterable,
    // User filter
    gitterUser => {
      const gitterUserId = gitterUser.id || gitterUser._id;

      // If we're in worker mode, only process a sub-section of the roomID's.
      // We partition based on part of the Mongo ObjectID.
      if (opts.workerIndex && opts.workerTotal) {
        // Partition based on the incrementing value part of the Mongo ObjectID. We
        // can't just `parseInt(objectId, 16)` because the number is bigger than 64-bit
        // (12 bytes is 96 bits) and we will lose precision
        const { incrementingValue } = mongoUtils.splitMongoObjectIdIntoPieces(gitterUserId);

        const shouldBeProcessedByThisWorker =
          incrementingValue % opts.workerTotal === opts.workerIndex - 1;
        return shouldBeProcessedByThisWorker;
      }

      return true;
    },
    // Process function
    async ({ value: gitterUser /*, laneIndex */ }) => {
      const gitterUserId = gitterUser.id || gitterUser._id;

      // Ensure that there is an associated Matrix user for Gitter user. This way there is
      // some MXID for us to insert the Synapse `user_external_ids` data for.
      const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

      // Lookup information from Identity
      //
      // XXX: This function is flawed for a select handful of users that accidentally
      // went through the GitHub repo scope OAuth upgrade flow before it was patched in
      // https://gitlab.com/gitterHQ/webapp/-/issues/2328. This means that
      // Twitter/GitLab users also have `githubToken`/`githubScopes` defined which
      // triggers some of our simplistic logic to assume they are a GitHub user and
      // choose GitHub as the identity wrongly. This flaw in the data was noticed by @clokep,
      // https://gitlab.com/gitterHQ/webapp/-/issues/2856#note_1243268761
      const primaryIdentity = await identityService.findPrimaryIdentityForUser(gitterUser);

      // Append info to ndjson file
      const data = {
        gitterUserId,
        mxid: gitterUserMxid,
        provider: primaryIdentity.provider,
        providerKey: primaryIdentity.providerKey
      };
      runningDataList.push(data);

      // Even though this is running in a "concurrent" queue, Node.js is single threaded
      // and we can safely just run this at whatever point we want and reset it without
      // worry about duplicating the output or losing data.
      if (runningDataList.length >= 100) {
        // Copy the data we want to persist and reset the list before we do the async
        // `appendToDataDumpFile` call to avoid the length condition above being true
        // for multiple concurrent things while we persist and end-up duplicating data
        // in the dump.
        const dataToPersist = runningDataList;
        runningDataList = [];

        await appendToDataDumpFile(dataToPersist);

        // Write a dot to the console to let them know that the script is still chugging
        // successfully
        rl.write('.');
      }
    }
  );

  // Append the last leftover info
  if (runningDataList.length >= 0) {
    await appendToDataDumpFile(runningDataList);
    // Reset after we've persisted this info
    runningDataList = [];
  }

  // If we're done filling, write a newline so the next log doesn't appear
  // on the same line as the .....
  rl.write('\n');

  const failedItemIds = concurrentQueue.getFailedItemIds();
  if (failedItemIds.length === 0) {
    logger.info(`Successfully dumped all users with no errors`);
  } else {
    logger.info(
      `Done dumping data for all users but failed to process ${failedItemIds.length} users`
    );
    logger.info(JSON.stringify(failedItemIds));
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item failures above). dataDumpFilePath=${dataDumpFilePath}`
    );
  })
  .catch(err => {
    logger.error(
      `Error occurred while running through the process of dumping Gitter, Matrix, Identity, data:`,
      err.stack
    );
  })
  .then(async () => {
    // We're done writing to the console with this thing
    rl.close();

    if (stopBridge) {
      await stopBridge();
    }

    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
