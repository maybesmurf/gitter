#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');

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

let numberOfRoomsUpdated = 0;
const failedRoomUpdates = [];

async function updateAllRooms() {
  const cursor = persistence.MatrixBridgedRoom.find()
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(25)
    .cursor();

  const iterable = iterableFromMongooseCursor(cursor);

  for await (let bridgedRoomEntry of iterable) {
    try {
      console.log(
        `Updating matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`
      );
      await matrixUtils.ensureCorrectRoomState(
        bridgedRoomEntry.matrixRoomId,
        bridgedRoomEntry.troupeId
      );
      numberOfRoomsUpdated += 1;
    } catch (err) {
      console.error(
        `Failed to update matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`,
        err,
        err.stack
      );
      failedRoomUpdates.push(bridgedRoomEntry);
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

    console.log('Starting to update all bridged rooms');
    await updateAllRooms();
    console.log(`All bridged matrix rooms(${numberOfRoomsUpdated}) updated!`);

    if (failedRoomUpdates.length) {
      console.warn(
        `But some rooms failed to update (${failedRoomUpdates.length})`,
        failedRoomUpdates
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
