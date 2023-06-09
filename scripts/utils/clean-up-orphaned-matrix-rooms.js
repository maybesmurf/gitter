#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/clean-up-orphaned-matrix-rooms.js
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/clean-up-orphaned-matrix-rooms.js
//
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const env = require('gitter-web-env');
const config = env.config;

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const configuredServerName = config.get('matrix:bridge:serverName');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('delay', {
    alias: 'd',
    type: 'number',
    required: true,
    default: 2000,
    description:
      'Delay timeout(in milliseconds) between rooms to shutdown to not overwhelm the homeserver'
  })
  .option('dry-run', {
    description: 'Dry-run. Do not execute, just print',
    type: 'boolean',
    default: false
  })
  .help('help')
  .alias('help', 'h').argv;

// Number of rooms we shutdown
let numberOfRoomsShutdown = 0;
// Number of we tried to shutdown but ran into an error
// probably because they are already deleted.
let numberOfRoomsIgnored = 0;
// Number of rooms skipped because they don't belong to the `gitter.im`
// homeserver
let numberOfRoomsSkipped = 0;
const failedBridgedRoomShutdowns = [];

async function shutdownBridgedMatrixRoom(bridgedRoomEntry) {
  try {
    assert(bridgedRoomEntry.matrixRoomId);
    assert(bridgedRoomEntry.troupeId);
    console.log(
      `${opts.dryRun ? 'Dry-run: ' : ''}Shutting down matrixRoomId=${
        bridgedRoomEntry.matrixRoomId
      }, gitterRoomId=${bridgedRoomEntry.troupeId}`
    );

    if (!opts.dryRun) {
      await matrixUtils.shutdownMatrixRoom(bridgedRoomEntry.matrixRoomId);
    }
    console.log('\t✅');
    numberOfRoomsShutdown += 1;
  } catch (err) {
    // This error occurs for rooms which don't exist or we can't get access to
    // the room anyway. We don't need to worry about these cases. e.g.
    // "M_FORBIDDEN: User @gitter-badger:my.matrix.host not in room
    // !1605079432013:localhost, and room previews are disabled"
    if (err.errcode === 'M_FORBIDDEN') {
      console.log(`\t⏩ -> ${err.errcode}: ${err.error}`);
      numberOfRoomsIgnored += 1;
    } else {
      throw err;
    }
  }
}

async function shutdownOrphanedRooms() {
  // Find bridged Matrix rooms where the Gitter room (troupe) no longer exists
  const cursor = await persistence.MatrixBridgedRoom.aggregate([
    {
      // Lookup troupes._id === matricesbridgedroom.troupeId
      $lookup: {
        from: 'troupes',
        // Field from MatrixBridgedRoom
        localField: 'troupeId',
        // Field from Troupe
        foreignField: '_id',
        as: 'troupe'
      }
    },
    {
      $match: {
        'troupe._id': {
          $exists: false
        }
      }
    }
  ])
    .read(mongoReadPrefs.secondaryPreferred)
    .cursor({ batchSize: 100, async: true })
    .exec();

  const iterable = iterableFromMongooseCursor(cursor);

  for await (let bridgedRoomEntry of iterable) {
    try {
      // Only shutdown `*:gitter.im` rooms. Someone could have granted the
      // `@gitter-badger:gitter.im` admin power_levels on their own Matrix room
      // (portal room) and had us set up the bridge. We don't want to delete
      // their own room.
      const [, serverName] = bridgedRoomEntry.matrixRoomId.split(':');
      if (serverName !== configuredServerName) {
        console.log(`🕳 Skipping non-${configuredServerName} room ${bridgedRoomEntry.matrixRoomId}`);
        numberOfRoomsSkipped += 1;
        continue;
      }

      await shutdownBridgedMatrixRoom(bridgedRoomEntry);
    } catch (err) {
      console.error(
        `Failed to shutdown matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`,
        err,
        err.stack
      );
      failedBridgedRoomShutdowns.push(bridgedRoomEntry);
    }

    // Put a delay between each time we process and shutdown a bridged room
    // to avoid overwhelming and hitting the rate-limits on the Matrix homeserver
    if (opts.delay > 0) {
      await new Promise(resolve => {
        setTimeout(resolve, opts.delay);
      });
    }
  }
}

async function run() {
  try {
    if (opts.dryRun) {
      console.log('Dry-run, nothing will actually be deleted =================');
      console.log('===========================================================');
    }

    console.log('Setting up Matrix bridge');
    await installBridge();

    console.log('Starting to shutdown orphaned bridged rooms');
    await shutdownOrphanedRooms();
    console.log(
      `${numberOfRoomsShutdown} orphaned bridged rooms shutdown!\n` +
        `Ignored ${numberOfRoomsIgnored} orphaned rooms which are already deleted.\n` +
        `Skipped ${numberOfRoomsSkipped} non-${configuredServerName} rooms.`
    );

    if (failedBridgedRoomShutdowns.length) {
      console.warn(
        `But some rooms failed to shutdown (${failedBridgedRoomShutdowns.length})`,
        failedBridgedRoomShutdowns
      );
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
