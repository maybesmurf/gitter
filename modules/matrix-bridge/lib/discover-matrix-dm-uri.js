'use strict';

//const MATRIX_DM_RE = /^matrix\/[0-9a-f]+\/@.*?/;

function discoverMatrixDmUri(uri) {
  const lcUri = uri.toLowerCase();
  const uriPieces = lcUri.split('/');

  // We're only looking for `matrix/123abc/@root:matrix.org` which has 3 pieces
  if (uriPieces.length !== 3 || uriPieces[0] !== 'matrix') {
    return null;
  }

  return {
    gitterUserId: uriPieces[1],
    virtualUserId: uriPieces[2]
  };
}

module.exports = discoverMatrixDmUri;
