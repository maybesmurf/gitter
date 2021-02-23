'use strict';

const assert = require('assert');
const {
  getCanonicalAliasLocalpartForGitterRoomUri,
  getCanonicalAliasForGitterRoomUri
} = require('../lib/matrix-alias-utils');

describe('matrix-alias-utils', () => {
  describe('getCanonicalAliasLocalpartForGitterRoomUri', () => {
    it('should replace forward slashes', () => {
      assert.strictEqual(
        getCanonicalAliasLocalpartForGitterRoomUri('gitterhq/gitter'),
        'gitterhq_gitter'
      );
    });

    it('should replace forward slashes in nested slash rooms', () => {
      assert.strictEqual(
        getCanonicalAliasLocalpartForGitterRoomUri('gitterhq/nested/room'),
        'gitterhq_nested_room'
      );
    });
  });

  describe('getCanonicalAliasForGitterRoomUri', () => {
    it('should replace forward slashes', () => {
      assert.strictEqual(
        getCanonicalAliasForGitterRoomUri('gitterhq/gitter'),
        '#gitterhq_gitter:my.matrix.host'
      );
    });

    it('should replace forward slashes in nested slash rooms', () => {
      assert.strictEqual(
        getCanonicalAliasForGitterRoomUri('gitterhq/nested/room'),
        '#gitterhq_nested_room:my.matrix.host'
      );
    });
  });
});
