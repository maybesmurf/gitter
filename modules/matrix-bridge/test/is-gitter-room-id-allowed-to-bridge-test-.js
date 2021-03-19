'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');

const isGitterRoomIdAllowedToBridge = require('../lib/is-gitter-room-id-allowed-to-bridge');

describe('isGitterRoomIdAllowedToBridge', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {},
    troupe1: {},
    troupePublic1: {},
    troupePrivate1: {
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false
      }
    },
    troupeMatrixDm1: {
      uri: 'matrix/1234abcde/@bob:matrix.org'
    },
    troupeFakeMatrixDm1: {
      uri: 'matrixnotgroup/1234abcde/@bob:matrix.org',
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false
      }
    }
  });

  it('public room can bridge', async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupePublic1.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it(`private room can't bridge`, async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupePrivate1.id);
    assert.strictEqual(allowedToBridge, false);
  });

  it('Matrix DM can bridge', async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupeMatrixDm1.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it(`Random group with "matrix" in name can't bridge`, async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupeFakeMatrixDm1.id);
    assert.strictEqual(allowedToBridge, false);
  });
});
