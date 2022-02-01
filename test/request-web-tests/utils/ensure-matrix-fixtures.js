'use strict';

const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger.get('matrix-bridge/test/util/ensure-matrix-fixtures');

const createUsers = require('gitter-web-test-utils/lib/create-users');
const createGroups = require('gitter-web-test-utils/lib/create-groups');
const groupService = require('gitter-web-groups');
const userService = require('gitter-web-users');

const gitterBridgeBackingUsername = config.get('matrix:bridge:gitterBridgeBackingUsername');
const gitterBridgeProfileUsername = config.get('matrix:bridge:gitterBridgeProfileUsername');

async function ensureMatrixFixtures() {
  const userFixtures = {};

  // Create the backing bridge user on the Gitter side if it doesn't already exist.
  // We don't have access to dependency inject this like we do in the smaller unit tests
  // so let's just create the user like it exists for real.
  const gitterBridgeBackingUser = await userService.findByUsername(gitterBridgeBackingUsername);
  if (!gitterBridgeBackingUser) {
    logger.info(
      `Matrix gitterBridgeBackingUser not found, creating test fixture user (${gitterBridgeBackingUsername}) to smooth it over.`
    );
    userFixtures.userBridge1 = {
      username: gitterBridgeBackingUsername
    };
  }

  // Create the profile bridge user on the Gitter side if it doesn't already exist.
  // We don't have access to dependency inject this like we do in the smaller unit tests
  // so let's just create the user like it exists for real.
  const gitterBridgeProfileUser = await userService.findByUsername(gitterBridgeProfileUsername);
  if (
    !gitterBridgeProfileUser &&
    // Also make sure we're not trying to create the same user if they are configured to be the same
    gitterBridgeProfileUsername !== gitterBridgeBackingUsername
  ) {
    logger.info(
      `Matrix gitterBridgeProfileUser not found, creating test fixture user (${gitterBridgeProfileUsername}) to smooth it over.`
    );
    userFixtures.userBridgeProfile1 = {
      username: gitterBridgeProfileUsername
    };
  }

  // Re-using the test fixture setup functions
  let f = {};
  await createUsers(userFixtures, f);

  const matrixDmGroup = await groupService.findByUri('matrix', { lean: true });
  if (!matrixDmGroup) {
    logger.info('Matrix DM group not found, creating test fixture group to smooth it over.');

    // Re-using the test fixture setup functions
    let f = {};
    await createGroups(
      {
        groupMatrix: {
          uri: 'matrix'
        }
      },
      f
    );
  }
}

module.exports = ensureMatrixFixtures;
