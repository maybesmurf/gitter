'use strict';

const assert = require('assert');

// via https://stackoverflow.com/a/19722641/796832
function _roundNumber(number, places) {
  assert(places);
  return +(Math.round(number + 'e+' + places) + 'e-' + places);
}

// Based on https://stackoverflow.com/a/17633552/796832
function formatDurationInMsToPrettyString(durationInMs) {
  const timeScales = [
    { msScale: 24 * 60 * 60 * 1e3, suffix: 'd' },
    { msScale: 60 * 60 * 1e3, suffix: 'h' },
    { msScale: 60 * 1e3, suffix: 'm' },
    { msScale: 1e3, suffix: 's' },
    { msScale: 1, suffix: 'ms' }
  ];

  for (let timeScale of timeScales) {
    if (durationInMs >= timeScale.msScale) {
      return `${_roundNumber(durationInMs / timeScale.msScale, 2)}${timeScale.suffix}`;
    }
  }

  return `${_roundNumber(durationInMs, 2)}ms`;
}

module.exports = formatDurationInMsToPrettyString;
