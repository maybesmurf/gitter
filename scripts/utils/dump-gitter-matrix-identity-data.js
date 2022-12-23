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
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const identityService = require('gitter-web-identity');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const DB_BATCH_SIZE_FOR_USERS = 256;

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('resume-from-gitter-user-id', {
    type: 'string',
    description:
      'The Gitter user ID to start the incremental dump from. Otherwise will dump everything available in the database.'
  })
  .help('help')
  .alias('help', 'h').argv;

const tempDirectory = path.join(os.tmpdir(), 'gitter-matrix-identity-data-dump');
mkdirp.sync(tempDirectory);
const dataDumpFilePath = path.join(
  tempDirectory,
  `./gitter-matrix-identity-data-dump-${Date.now()}.ndjson`
);
logger.info(`Writing to data dump to dataDumpFilePath=${dataDumpFilePath}`);

async function appendToDataDumpFile(dataList) {
  const ndJsonString = dataList
    .map(data => {
      return JSON.stringify(data);
    })
    .join('\n');

  return appendFile(dataDumpFilePath, ndJsonString);
}

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

  const gitterUserCursor = persistence.User.find({
    // TODO: Resume position to make incremental dump
  })
    // Go from oldest to most recent for a consistent incremental dump
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_USERS)
    .cursor();
  const gitterUserStreamIterable = iterableFromMongooseCursor(gitterUserCursor);

  const failedItemIds = [];
  let runningDataList = [];
  for await (let gitterUser of gitterUserStreamIterable) {
    const gitterUserId = gitterUser.id || gitterUser._id;
    try {
      // Ensure that there is an associated Matrix user for Gitter user. This way there is
      // some MXID for us to insert the Synapse `user_external_ids` data for.
      const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

      // Lookup information from Identity
      const primaryIdentity = await identityService.findPrimaryIdentityForUser(gitterUser);

      // Append info to ndjson file
      const data = {
        gitterUserId,
        mxid: gitterUserMxid,
        provider: primaryIdentity.provider,
        providerKey: primaryIdentity.providerKey
      };
      runningDataList.push(data);

      if (runningDataList.length >= 100) {
        await appendToDataDumpFile(runningDataList);

        // Write a dot to the console to let them know that the script is still chugging
        // successfully
        rl.write('.');

        // Reset after we've persisted this info
        runningDataList = [];
      }
    } catch (err) {
      logger.error(`Failed to process gitterUserId=${gitterUserId}`, err.stack);
      failedItemIds.push(gitterUserId);
    }
  }

  // Append the last leftover info
  if (runningDataList.length >= 0) {
    await appendToDataDumpFile(runningDataList);
    // Reset after we've persisted this info
    runningDataList = [];
  }

  // If we're done filling, write a newline so the next log doesn't appear
  // on the same line as the .....
  rl.write('\n');

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
