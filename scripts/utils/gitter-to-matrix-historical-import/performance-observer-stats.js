'use strict';

const assert = require('assert');
const debug = require('debug')('gitter:scripts:matrix-historical-import:stats');
const { PerformanceObserver } = require('perf_hooks');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;

// via https://stackoverflow.com/a/19722641/796832
function _roundNumber(number, places) {
  assert(places);
  return +(Math.round(number + 'e+' + places) + 'e-' + places);
}

// Based on https://stackoverflow.com/a/17633552/796832
function _formatDurationInMsToPrettyString(durationInMs) {
  const timeScales = [
    { msScale: 60 * 1e6, suffix: 'm' },
    { msScale: 1e6, suffix: 's' },
    { msScale: 1, suffix: 'ms' }
  ];

  for (let timeScale of timeScales) {
    if (durationInMs >= timeScale) {
      return `${_roundNumber(durationInMs / timeScale.msScale, 2)}${timeScale.suffix}`;
    }
  }

  return `${_roundNumber(durationInMs, 2)}ms`;
}

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

    debug(`${entry.name} took ${_formatDurationInMsToPrettyString(entry.duration)}`);

    stats.responseTime(entry.name, entry.duration);
  })
);
observer.observe({ buffered: true, entryTypes: ['measure'] });
