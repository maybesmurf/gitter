#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/ensure-existing-bridged-matrix-room-up-to-date.js --uri some/room
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/ensure-existing-bridged-matrix-room-up-to-date.js --uri some/room
//
'use strict';

const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

require('../../server/event-listeners').install();

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to update'
  })
  .help('help')
  .alias('help', 'h').argv;

async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    try {
      const room = await troupeService.findByUri(opts.uri);

      const bridgedRoomEntry = await persistence.MatrixBridgedRoom.findOne({
        troupeId: room._id
      }).exec();

      console.log(
        `Updating matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId}`
      );
      await matrixUtils.ensureCorrectRoomState(
        bridgedRoomEntry.matrixRoomId,
        bridgedRoomEntry.troupeId
      );
      console.log(`Bridged matrix room updated!`);
    } catch (err) {
      console.error(`Failed to update Matrix room`, err, err.stack);
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
