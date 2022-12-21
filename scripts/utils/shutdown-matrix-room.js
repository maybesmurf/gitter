#!/usr/bin/env node
//
// Usage:
//  - Linux/macOS: matrix__bridge__applicationServicePort=9001 node ./scripts/utils/shutdown-matrix-room.js --uri MadLittleMods/delete-test1
//  - Windows: set matrix__bridge__applicationServicePort=9001&&node ./scripts/utils/shutdown-matrix-room.js --uri MadLittleMods/delete-test1
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
  .option('gitter-uri', {
    description: 'URI of the Gitter room associated with the Matrix room ID to shutdown'
  })
  .option('matrix-room-id', {
    description: 'Matrix room ID to shutdown'
  })
  .help('help')
  .alias('help', 'h').argv;

async function getMatrixRoomIdFromArgs() {
  let matrixRoomId;
  if (opts.gitterUri) {
    const room = await troupeService.findByUri(opts.gitterUri);

    const bridgedRoomEntry = await persistence.MatrixBridgedRoom.findOne({
      troupeId: room._id
    }).exec();

    console.log(
      `Found matrixRoomId=${bridgedRoomEntry.matrixRoomId}, gitterRoomId=${bridgedRoomEntry.troupeId} from gitterUri=${opts.gitterUri}`
    );

    matrixRoomId = bridgedRoomEntry.matrixRoomId;
  } else if (opts.matrixRoomId) {
    matrixRoomId = opts.matrixRoomId;
  }

  if (!matrixRoomId) {
    throw new Error('No Matrix room ID provided (`--gitter-uri` or `--matrix-room-id`)');
  }

  return matrixRoomId;
}

async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    try {
      const matrixRoomId = await getMatrixRoomIdFromArgs();

      console.log(`Deleting matrixRoomId=${matrixRoomId}`);
      await matrixUtils.shutdownMatrixRoom(matrixRoomId, {
        forceRemoveIfNoGitterRoom: true
      });
      console.log(`Matrix room deleted!`);
    } catch (err) {
      console.error(`Failed to delete Matrix room: ${err.message}`);
      throw err;
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
