'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const { writeFile, appendFile } = require('fs').promises;

const env = require('gitter-web-env');
const logger = env.logger;
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const userService = require('gitter-web-users');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('json-list-file-path', {
    type: 'string',
    description: 'The path where to read the JSON list of Gitter user IDs from'
  })
  .help('help')
  .alias('help', 'h').argv;

const gitterUserIds = require(opts.jsonListFilePath);

const tempDirectory = path.join(os.tmpdir(), 'gitter-matrix-identity-data-dump');
mkdirp.sync(tempDirectory);
const dataDumpFilePath = path.join(
  tempDirectory,
  `./gitter-matrix-identity-data-dump-from-json-list-${Date.now()}.ndjson`
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

  let failedGitterUserIds = [];
  let runningDataList = [];
  for (let gitterUserId of gitterUserIds) {
    try {
      assert(mongoUtils.isLikeObjectId(gitterUserId));
      const gitterUser = await userService.findById(gitterUserId);

      // Ensure that there is an associated Matrix user for Gitter user. This way there is
      // some MXID for us to insert the Synapse `user_external_ids` data for.
      const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

      // Append info to ndjson file
      const data = {
        gitterUserId,
        mxid: gitterUserMxid,
        // This is flawed with #multiple-identity-user so make sure to update this when that happens
        provider: gitterUser.identities[0].provider,
        providerKey: gitterUser.identities[0].providerKey
      };
      runningDataList.push(data);
    } catch (err) {
      failedGitterUserIds.push(gitterUserId);
      logger.error(`Failed to process gitterUserId=${gitterUserId}`, {
        exception: err
      });
    }
  }

  // Append the last leftover info
  if (runningDataList.length >= 0) {
    await appendToDataDumpFile(runningDataList);
    // Reset after we've persisted this info
    runningDataList = [];
  }

  if (failedGitterUserIds.length === 0) {
    logger.info(`Successfully dumped all users with no errors`);
  } else {
    logger.info(
      `Done dumping data for all users but failed to process ${failedGitterUserIds.length} users`
    );
    logger.info(JSON.stringify(failedGitterUserIds));
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
    if (stopBridge) {
      await stopBridge();
    }

    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
