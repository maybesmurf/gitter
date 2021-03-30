'use strict';
const env = require('gitter-web-env');
const config = env.config;
const serverName = config.get('matrix:bridge:serverName');

function getMxidForGitterUser(gitterUser) {
  const mxid = `@${gitterUser.username.toLowerCase()}-${gitterUser.id}:${serverName}`;
  return mxid;
}

module.exports = getMxidForGitterUser;
