#!/usr/bin/env node
'use strict';

process.env.DISABLE_API_LISTEN = '1';

const yargs = require('yargs');
const LineByLineReader = require('line-by-line');
const shutdown = require('shutdown');
const persistence = require('gitter-web-persistence');
const troupeService = require('gitter-web-rooms/lib/troupe-service');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = yargs
  .option('room-store-file', {
    required: true,
    description: 'path to the room store file (room-store.db)',
    string: true
  })
  .option('delay', {
    alias: 'd',
    type: 'number',
    required: true,
    default: 2000,
    description: 'Delay(in milliseconds) between rooms to update to not overwhelm the homeserver'
  })
  .option('dry-run', {
    description: 'Dry-run. Do not execute, just print',
    type: 'boolean',
    default: false
  })
  .help('help')
  .alias('help', 'h').argv;

async function migrateRoom(roomEntry) {
  console.log('Processing roomEntry', roomEntry);

  if (!opts.dryRun) {
    const matrixRoomId = roomEntry.matrix_id;
    const gitterRoomUri = roomEntry.remote_id;

    const bridgeIntent = matrixBridge.getIntent();
    await bridgeIntent.join(matrixRoomId, ['matrix.org']);

    const gitterRoom = await troupeService.findByUri(gitterRoomUri);

    await persistence.MatrixBridgedRoom.update(
      { troupeId: gitterRoom.id },
      {
        $set: {
          matrixRoomId
        }
      }
    );

    await matrixUtils.ensureRoomAliasesForGitterRoom(matrixRoomId, gitterRoom);
  }
}

async function run() {
  try {
    console.log('Setting up Matrix bridge');
    await installBridge();

    const lr = new LineByLineReader(opts.roomStoreFile);

    lr.on('error', err => {
      console.error('Error while reading lines', err);
      shutdown.shutdownGracefully(1);
    });

    lr.on('line', async line => {
      lr.pause();

      const roomEntry = JSON.parse(line);

      if (!roomEntry.matrix_id || !roomEntry.remote_id) {
        return;
      }
      // We're only looking for plumbed rooms
      if (roomEntry && roomEntry.data && roomEntry.data.portal) {
        return;
      }

      await migrateRoom(roomEntry);

      // Put a delay between each time we process a room
      // to avoid overwhelming and hitting the rate-limits on the Matrix homeserver
      if (opts.delay > 0) {
        await new Promise(resolve => {
          setTimeout(resolve, opts.delay);
        });
      }

      lr.resume();
    });

    lr.on('end', () => {
      console.log('All lines processed');

      shutdown.shutdownGracefully();
    });
  } catch (err) {
    console.error(err, err.stack);
    shutdown.shutdownGracefully(1);
  }
}

run();
