#!/usr/bin/env node
'use strict';

const { PerformanceObserver } = require('perf_hooks');
const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:backfill-existing-history-to-matrix');
const env = require('gitter-web-env');
const logger = env.logger;
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const handleMainMessages = require('./matrix-historical-import/handle-main-messages');

const matrixUtils = new MatrixUtils(matrixBridge);

const observer = new PerformanceObserver(list =>
  list.getEntries().forEach(entry => debug(`${entry.name} took ${entry.duration / 1000}s`))
);
observer.observe({ buffered: true, entryTypes: ['measure'] });

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'Uri of the room to delete'
  })
  .help('help')
  .alias('help', 'h').argv;

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  debug(
    `Found matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  // TODO: We can only backfill in rooms which we can control
  // because we know the @gitter-badger:gitter.im is the room creator
  // which is the only user who can backfill in existing room versions.

  await handleMainMessages(gitterRoom, matrixRoomId);
  await handleThreadedConversationRelations(gitterRoom, matrixRoomId);
}

exec()
  .then(() => {
    logger.info(`Successfully imported all historical messages for ${opts.uri}`);
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error('Error occurred while backfilling events:', err.stack);
    shutdown.shutdownGracefully();
  });
