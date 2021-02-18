'use strict';

const env = require('gitter-web-env');
const config = env.config;

const configuredServerName = config.get('matrix:bridge:serverName');

const GITTER_MXID_LOCALPART_REGEX = /^@(.*?)-([a-f0-9]+)$/;

// Given a MXID from Matrix like `@MadLittleMods-5f762e89986e461e663059c2:gitter.im`
// Parse it out into the useful pieces
function parseGitterMxid(mxid) {
  // Only replace pill mentions for `*:gitter.im`
  const [localPart, serverName] = mxid.split(':');

  // If the MXID is from the Gitter homeserver, it's probably a bridged user from Gitter.
  if (serverName === configuredServerName) {
    // We're matching against the MXID @madlittlemods-5f762e89986e461e663059c2:gitter.im
    // where the localPart is `@madlittlemods-5f762e89986e461e663059c2`
    const localPartMatches = localPart.match(GITTER_MXID_LOCALPART_REGEX);

    if (!localPartMatches) {
      return null;
    }

    const username = localPartMatches[1];
    const userId = localPartMatches[2];

    return {
      mxid,
      username,
      userId,
      serverName
    };
  }

  return null;
}

module.exports = parseGitterMxid;
