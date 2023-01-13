'use strict';
const env = require('gitter-web-env');
const config = env.config;
const serverName = config.get('matrix:bridge:serverName');

function getMxidForGitterUser(gitterUser) {
  // Our goal is to remove the `~` from the ghosted username because it will get escaped by the
  // bridging libraries otehrwise and cause MXID mismatches and then claims we haven't
  // registered the user yet.
  //
  // Ghosted usernames look like `@ghost=7e5f762ffe986e461e663059f0-5f762ffe986e461e663059f0:gitter.im`
  if (gitterUser.username.startsWith('ghost~')) {
    return `@ghost-${gitterUser.id}:${serverName}`;
  }

  const mxid = `@${gitterUser.username.toLowerCase()}-${gitterUser.id}:${serverName}`;
  return mxid;
}

module.exports = getMxidForGitterUser;
