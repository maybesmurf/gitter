#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');

const env = require('gitter-web-env');
const logger = env.logger;
const identityService = require('gitter-web-identity');
const Identity = require('gitter-web-persistence').Identity;
const onMongoConnect = require('gitter-web-persistence-utils/lib/on-mongo-connect');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');

const BATCH_SIZE = 500;

// GitLab.com did the GitLab 15 migration to add expiration to all tokens on
// 2022-05-17. which means all tokens are already expired by the time we run
// this migration, see https://gitlab.com/gitterHQ/webapp/-/issues/2838#note_949966620
const EXPIRATION_DATE = new Date('2022-05-17');

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

  //console.log('explain', cursor.getQuery());

  const iterable = iterableFromMongooseCursor(cursor);

  let requests = [];
  function drainRequests() {
    //Identity.bulkWrite(requests);
    requests = [];
  }

  for await (let identityToMigrate of iterable) {
    //await new Promise(resolve => setTimeout(resolve, 20 * 1000));

    console.log('identityToMigrate', identityToMigrate);
    requests.push({
      updateOne: {
        filter: { _id: identityToMigrate._id },
        update: {
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
        }
      }
    });

    // Execute N write/update requests than re-init
    if (requests.length >= BATCH_SIZE) {
      drainRequests();
    }
  }

  drainRequests();
}

(async () => {
  try {
    logger.info('Connecting to Mongo...');
    await onMongoConnect();
    logger.info('Connected to Mongo ✅');
    logger.info(`Filling GitLab identities with refresh tokens...`);
    await fillGitLabIdentityRefreshTokens();
    logger.info(`Done filling ✅`);
  } catch (err) {
    logger.info('Error', err.stack);
  } finally {
    shutdown.shutdownGracefully();
  }
})();
