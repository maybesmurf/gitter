'use strict';

const assert = require('assert');
const discoverMatrixDmUri = require('../lib/discover-matrix-dm-uri');

const getMxidForGitterUser = require('../lib/get-mxid-for-gitter-user');

describe('discoverMatrixDmUri', () => {
  [
    {
      name: 'matches Matrix DM URI',
      uri: 'matrix/5f762f95986e461e663059d1/@mxid:host',
      expectedResult: {
        gitterUserId: '5f762f95986e461e663059d1',
        virtualUserId: '@mxid:host'
      }
    },
    {
      name: 'does not allow MXID from the Gitter homeserver',
      uri: `matrix/5f762f95986e461e663059d1/${getMxidForGitterUser({
        id: '5f762f95986e461e663059d1',
        username: 'some-gitter-user'
      })}`,
      expectedResult: null
    },
    {
      name: 'does not match matrix/ URL with too many slashes',
      uri: `matrix/5f762f95986e461e663059d1/@mxid:host/another-piece`,
      expectedResult: null
    },
    {
      name: 'does not match every room under the matrix/ community',
      uri: `matrix/internal-room`,
      expectedResult: null
    },
    {
      name: 'does not match some other room',
      uri: `postcss/postcss`,
      expectedResult: null
    }
  ].forEach(meta => {
    it(meta.name, () => {
      assert.deepEqual(discoverMatrixDmUri(meta.uri), meta.expectedResult);
    });
  });
});
