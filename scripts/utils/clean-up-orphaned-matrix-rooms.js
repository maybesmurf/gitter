#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/clean-up-orphaned-matrix-rooms.js
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/clean-up-orphaned-matrix-rooms.js
//
'use strict';

const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('delay', {
    alias: 'd',
    type: 'number',
    required: true,
    default: 2000,
    description:
      'Delay timeout(in milliseconds) between rooms to update to not overwhelm the homeserver'
  })
  .help('help')
  .alias('help', 'h').argv;

let numberOfRoomsShutdown = 0;
const failedBridgedRoomShutdowns = [];

async function shutdownOrphanedRooms() {
  // This is the date that we shipped
  // https://gitlab.com/gitterHQ/webapp/-/merge_requests/2265 and started
  // bridging Gitter room deletions to Matrix automatically. Shipped in
  // https://gitlab.com/gitterHQ/webapp/-/blob/develop/CHANGELOG.md#21450-2021-12-08
  // which shipped to production on 2021-12-14
  // (https://twitter.com/gitchat/status/1470908553787772931). We chose
  // 2021-12-16 just to be safe by a day.
  //
  // We only need to look at rooms that were created before that time.
  const cutoffId = mongoUtils.createIdForTimestamp(new Date('2021-12-16').getTime());

  const cursor = await persistence.MatrixBridgedRoom.aggregate([
    {
      $match: {
        _id: { $lt: cutoffId }
      }
    },
    { $project: { troupeId: 1 } },
    {
      // Lookup troupes._id === matricesbridgedroom.troupeId
      $lookup: {
        from: 'troupes',
        localField: 'troupeId',
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
    .cursor({ batchSize: 1000, async: true })
    .exec();

  console.log('cursor', cursor);

  // cursor.each(function(error, bridgedRoomEntry) {
  //   if (error) {
  //     console.log('cursor error', error);
  //   }

  //   console.log(
  //     `Shutting down matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`
  //   );
  // });

  const iterable = iterableFromMongooseCursor(cursor);

  for await (let bridgedRoomEntry of iterable) {
    try {
      console.log(
        `Shutting down matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`
      );

      numberOfRoomsShutdown += 1;
    } catch (err) {
      console.error(
        `Failed to shutdown matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`,
        err,
        err.stack
      );
      failedBridgedRoomShutdowns.push(bridgedRoomEntry);
    }

    // Put a delay between each time we process and update a bridged room
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
    console.log('Setting up Matrix bridge');
    await installBridge();

    console.log('Starting to shutdown orphaned bridged rooms');
    await shutdownOrphanedRooms();
    console.log(`${numberOfRoomsShutdown} orphaned bridged shutdown!`);

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
