'use strict';

const env = require('gitter-web-env');
const config = env.config;
const serverName = config.get('matrix:bridge:serverName');

function getCanonicalAliasLocalpartForGitterRoomUri(uri) {
  return uri.replace(/\//g, '_');
}

function getCanonicalAliasForGitterRoomUri(uri) {
  return `#${getCanonicalAliasLocalpartForGitterRoomUri(uri)}:${serverName}`;
}

module.exports = {
  getCanonicalAliasLocalpartForGitterRoomUri,
  getCanonicalAliasForGitterRoomUri
};
