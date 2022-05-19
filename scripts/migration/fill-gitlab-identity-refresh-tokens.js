#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const readline = require('readline');

const env = require('gitter-web-env');
const logger = env.logger;
const identityService = require('gitter-web-identity');
const Identity = require('gitter-web-persistence').Identity;
const onMongoConnect = require('gitter-web-persistence-utils/lib/on-mongo-connect');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');

// The number of identities to process at once from the database
const BATCH_SIZE = 500;

// GitLab.com did the GitLab 15 migration to add expiration to all tokens on
// 2022-05-17. which means all tokens are already expired by the time we run
// this migration, see https://gitlab.com/gitterHQ/webapp/-/issues/2838#note_949966620
const EXPIRATION_DATE = new Date('2022-05-17');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let numberofIdentitiesFilled = 0;
async function fillGitLabIdentityRefreshTokens() {
  // We have 96231 `gitlab` provider identities in the production database as of 2022-05-17
  const cursor = Identity.find({
    provider: identityService.GITLAB_IDENTITY_PROVIDER,
    // Only grab the indentities we haven't migrated in case we need to run this
    // script multiple times before it fully completes.
    refreshToken: {
      $exists: false
    }
  })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(BATCH_SIZE)
    .cursor();

  const iterable = iterableFromMongooseCursor(cursor);

  let bulk = Identity.collection.initializeUnorderedBulkOp();
  let requestCount = 0;
  async function drainRequests() {
    if (requestCount === 0) {
      logger.info('Skipping this request drain since no requests to make');
      return;
    }

    // Write a dot to the console to let them know that the script is still chugging successfully
    rl.write('.');
    // Do the bulk write to the database to update everything
    await new Promise((resolve, reject) => {
      bulk.execute(err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    // Re-init
    bulk = Identity.collection.initializeUnorderedBulkOp();
    requestCount = 0;
  }

  for await (let identityToMigrate of iterable) {
    bulk.find({ _id: identityToMigrate._id }).updateOne({
      $set: {
        // Set an expiration we know to refresh later when that code is introduced.
        // See https://gitlab.com/gitterHQ/webapp/-/merge_requests/2283
        accessTokenExpires: EXPIRATION_DATE,
        // Copy(migrate) the `accessTokenSecret` field to the `refreshToken` field. For some
        // reason, previously, we were writing the refreshToken to the
        // accessTokenSecret field.
        refreshToken: identityToMigrate.accessTokenSecret
      },
      $unset: {
        // Now that the field is copied above, clear it out
        accessTokenSecret: ''
      }
    });

    numberofIdentitiesFilled++;
    requestCount++;

    // Execute N write/update requests then re-init
    if (requestCount >= BATCH_SIZE) {
      await drainRequests();
    }
  }

  // After we're done iterating, make sure to drain the leftover requests
  await drainRequests();

  // If we're done filling, write a newline so the next log doesn't appear
  // on the same line as the .....
  rl.write('\n');
}

(async () => {
  try {
    logger.info('Connecting to Mongo...');
    await onMongoConnect();
    logger.info('Connected to Mongo ✅');
    logger.info(`Filling GitLab identities with refresh tokens...`);
    await fillGitLabIdentityRefreshTokens();
    logger.info(`Done after filling ${numberofIdentitiesFilled} identities ✅`);
  } catch (err) {
    logger.info('Error while filling', err.stack);
  } finally {
    rl.close();
    shutdown.shutdownGracefully();
  }
})();
