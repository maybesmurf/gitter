'use strict';

const { watchFile } = require('fs');
const readline = require('readline');
const _ = require('lodash');

function getLaneStatusMessage(laneMetaInfo) {
  return `${Math.random()}\n${Math.random()}\n${Math.random()}`;
}
