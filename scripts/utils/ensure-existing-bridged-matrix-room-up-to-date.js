#!/usr/bin/env node
'use strict';

const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

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
    } catch (err) {
      console.error(`Failed to update Matrix room`, err, err.stack);
    }

    console.log(`Bridged matrix room updated!`);
  } catch (err) {
    console.error(err, err.stack);
  }
  shutdown.shutdownGracefully();
}

run();
