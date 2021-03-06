'use strict';

const parseGitterMxid = require('./parse-gitter-mxid');

function discoverMatrixDmUri(uri) {
  // This can happen for Gitter one to one rooms that have no URI
  if (!uri) {
    return null;
  }

  const lcUri = uri.toLowerCase();
  const uriPieces = lcUri.split('/');

  // We're only looking for `matrix/123abc/@root:matrix.org` which has 3 pieces
  if (uriPieces.length !== 3 || uriPieces[0] !== 'matrix') {
    return null;
  }

  const gitterUserId = uriPieces[1];
  const virtualUserId = uriPieces[2];

  // Block starting a DM for any user from the `gitter.im` homeserver
  const parsedGitterMxid = parseGitterMxid(virtualUserId);
  if (parsedGitterMxid) {
    return null;
  }

  return {
    gitterUserId,
    virtualUserId
  };
}

module.exports = discoverMatrixDmUri;
