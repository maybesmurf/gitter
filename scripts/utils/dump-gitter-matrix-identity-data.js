#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const path = require('path');
const os = require('os');
const mkdirp = require('mkdirp');
const fsPromises = require('fs').promises;
const appendFile = fsPromises.appendFile;
//const debug = require('debug')('gitter:scripts:matrix-historical-import-worker');

const env = require('gitter-web-env');
const logger = env.logger;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const identityService = require('gitter-web-identity');

const DB_BATCH_SIZE_FOR_USERS = 256;

const opts = require('yargs')
  .option('resume-from-gitter-user-id', {
    type: 'string',
    required: true,
    description:
      'The Gitter user ID to start the incremental dump from. Otherwise will dump everything available in the database.'
  })
  .help('help')
  .alias('help', 'h').argv;

const tempDirectory = path.join(os.tmpdir(), 'gitter-matrix-identity-data-dump');
mkdirp.sync(tempDirectory);
const dataDumpFilePath = path.join(
  tempDirectory,
  `./gitter-matrix-identity-data-dump-${new Date().toISOString()}.ndjson`
);
async function appendToDataDumpFile(dataList) {
  const ndJsonString = dataList
    .map(data => {
      return JSON.stringify(data);
    })
    .join('\n');

  return appendFile(dataDumpFilePath, ndJsonString);
}

// eslint-disable-next-line max-statements
async function exec() {
  const gitterUserCursor = persistence.Users.find({
    // TODO: Resume position to make incremental dump
  })
    // Go from oldest to most recent for a consistent incremental dump
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_USERS)
    .cursor();
  const gitterUserStreamIterable = iterableFromMongooseCursor(gitterUserCursor);

  let runningDataList = [];
  for await (let gitterUser of gitterUserStreamIterable) {
    const gitterUserId = gitterUser.id || gitterUser._id;
    // Ensure that there is an associated Matrix user for Gitter user. This way there is
    // some MXID for us to insert the Synapse `user_external_ids` data for.
    const gitterUserMxid = await this.matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

    // Lookup information from Identity
    const primaryIdentity = await identityService.findPrimaryIdentityForUser(gitterUser);

    // Append info to ndjson file
    const data = {
      gitterUserId,
      mxid: gitterUserMxid,
      provider: primaryIdentity.provider,
      providerKey: primaryIdentity.providerKey
    };
    runningDataList.append(data);

    if (runningDataList.length >= 100) {
      await appendToDataDumpFile(runningDataList);
      // Reset after we've persisted this info
      runningDataList = [];
    }
  }

  // Append the last leftover info
  if (runningDataList.length >= 0) {
    await appendToDataDumpFile(runningDataList);
    // Reset after we've persisted this info
    runningDataList = [];
  }
}

exec()
  .then(() => {
    logger.info(
      `Script finished without an error (check for individual item process failures above).`
    );
  })
  .catch(err => {
    logger.error(`Error occurred while TODO:`, err.stack);
  })
  .then(async () => {
    // And continue shutting down gracefully
    shutdown.shutdownGracefully();
  });
