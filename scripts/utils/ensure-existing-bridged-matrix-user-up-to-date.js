#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__skipMatrixBridgeUserProfileSetup=1 matrix__bridge__applicationServicePort=9001 node ./scripts/utils/ensure-existing-bridged-matrix-user-up-to-date.js --username MadLittleMods
//  - Windows: set matrix__bridge__applicationServicePort=9001&&set matrix__bridge__skipMatrixBridgeUserProfileSetup=1&&node ./scripts/utils/ensure-existing-bridged-matrix-user-up-to-date.js --username MadLittleMods
//
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const userService = require('gitter-web-users');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('username', {
    alias: 'u',
    required: true,
    description: 'Gitter username of the person you want to update'
  })
  .help('help')
  .alias('help', 'h').argv;

if (opts.keepExistingUserPowerLevels) {
  console.log(
    `Note: Keeping existing user power levels around (opts.keepExistingUserPowerLevels=${opts.keepExistingUserPowerLevels}).`
  );
}

async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    try {
      const user = await userService.findByUsername(opts.username);
      const gitterUserId = user.id;
      assert(gitterUserId);

      const bridgedUserEntry = await persistence.MatrixBridgedUser.findOne({
        userId: gitterUserId
      }).exec();

      console.log(`Updating mxid=${bridgedUserEntry.matrixId} (gitter username=${user.username})`);
      await matrixUtils.ensureCorrectMxidProfile(bridgedUserEntry.matrixId, gitterUserId);
      console.log(`Bridged matrix user updated!`);
    } catch (err) {
      console.error(`Failed to update Matrix user`, err, err.stack);
    }

    // wait 5 seconds to allow for asynchronous `event-listeners` to finish
    // This isn't clean but works
    // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
    // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  } catch (err) {
    console.error(err, err.stack);
  }
  shutdown.shutdownGracefully();
}

run();
