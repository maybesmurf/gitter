'use strict';

const debug = require('debug')('gitter:scripts:matrix-historical-import:stats');
const { PerformanceObserver } = require('perf_hooks');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;

const formatDurationInMsToPrettyString = require('./format-duration-in-ms-to-pretty-string');

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

    debug(`${entry.name} took ${formatDurationInMsToPrettyString(entry.duration)}`);

    stats.responseTime(entry.name, entry.duration);
  })
);
observer.observe({ buffered: true, entryTypes: ['measure'] });
