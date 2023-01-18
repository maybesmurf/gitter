'use strict';
const env = require('gitter-web-env');
const config = env.config;
const serverName = config.get('matrix:bridge:serverName');

function getMxidForGitterUser(gitterUser) {
  let usernamePiece = gitterUser.username.toLowerCase();
  // Our goal is to remove the `~` from the ghosted username because it will get escaped by the
  // bridging libraries as `=7e` otherwise and cause MXID mismatches and then claims we haven't
  // registered the user yet.
  //
  // Ghosted Gitter usernames look like `ghost~5f762ffe986e461e663059f0`
  if (gitterUser.username.startsWith('ghost~')) {
    usernamePiece = 'ghost';
  }
  // This is aimed at another edge case like `removed~foobar` that I sometimes renamed
  // people to while handling peoples E11000 problems and not wanting to be so
  // destructive while cleaning up their users,
  // https://gitlab.com/gitterHQ/support-runbook#resolve-e11000-duplicate-github-id-error-on-user-sign-in
  else if (gitterUser.username.includes('~')) {
    // A cheap better way to escape this that's consistent
    usernamePiece = usernamePiece.replace('~', '---');
  }

  const mxid = `@${usernamePiece}-${gitterUser.id}:${serverName}`;
  return mxid;
}

module.exports = getMxidForGitterUser;
