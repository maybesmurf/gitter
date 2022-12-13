#!/usr/bin/env node
'use strict';

// Why aren't we using MSC2716?
//
// - MSC2716 isn't fully polished. It works but it still a bit crunchy for federated
//   homeservers to backfill all of the history in order and we just punted this problem
//   to when Synapse supports online topological ordering which is beeeg future task.
// - Trying the MSC2716 version of this script out now (see
//   `scripts/utils/msc2716-backfill-existing-history-to-matrix.js`), the threads don't
//   automatically show up in Element. I'm not sure why Element isn't using the bundled
//   aggregations to show the thread preview. The threads do appear in the timeline once
//   you open the thread list view. This seems like it could be fixed but it's yet
//   another thing to do.
// - Also since Hydrogen doesn't support threads yet, the threads won't be visible in
//   the Matrix Public Archive or if they are, it will just be a big chunk where all the
//   thread reply fallbacks will be. It will be better if we can import messages one by
//   one and mix the thread replies right under the thread parent for easy viewing in
//   clients where threads aren't supported.

const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:matrix-historical-import');
const { PerformanceObserver } = require('perf_hooks');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');

const matrixUtils = new MatrixUtils(matrixBridge);

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to backfill'
  })
  .help('help')
  .alias('help', 'h').argv;

// Will log out any `performance.measure(...)` calls in subsequent code
const observer = new PerformanceObserver(list =>
  list.getEntries().forEach(entry => {
    if (entry.startTime === 0) {
      logger.warn(
        'Performance measurement entry had `startTime` of `0` which seems a bit fishy. ' +
          " Your measurement probably didn't start exactly when the app started up at time `0` so" +
          'this is probably more indicative a typo in the start/end marker string'
      );
    }

    if (entry.duration === 0) {
      logger.warn(
        'Performance measurement entry had `duration` of `0` which seems a bit fishy. ' +
          " Your measurement probably didn't last `0` seconds so" +
          'this is probably more indicative a typo in the start/end marker string'
      );
    }

    debug(`${entry.name} took ${entry.duration / 1000}s`);

    stats.responseTime(entry.name, entry.duration);
  })
);
observer.observe({ buffered: true, entryTypes: ['measure'] });

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  // Find our current live Matrix room
  let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );

  logger.info(
    `Starting import script for ${gitterRoom.uri} (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (live matrixRoomId=${matrixRoomId})`
  );

  await gitterToMatrixHistoricalImport(gitterRoomId);

  logger.info(
    `Successfully imported all historical messages for ${opts.uri} to matrixHistoricalRoomId=${matrixHistoricalRoomId}`
  );
}

exec()
  .then(() => {
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events for ${opts.uri}:`, err.stack);
    shutdown.shutdownGracefully();
  });
