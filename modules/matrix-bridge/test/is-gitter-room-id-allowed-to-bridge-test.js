'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');

const isGitterRoomIdAllowedToBridge = require('../lib/is-gitter-room-id-allowed-to-bridge');

describe('isGitterRoomIdAllowedToBridge', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {},
    user2: {},
    troupe1: {},
    troupePublic1: {},
    troupePrivate1: {
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false
      }
    },
    troupeOneToOne: {
      oneToOne: true,
      users: ['user1', 'user2']
    },
    troupeMatrixDm1: {
      uri: 'matrix/1234abcde/@bob:matrix.org'
    }
  });

  it('public room can bridge', async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupePublic1.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it(`private room can bridge`, async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupePrivate1.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it(`one to one room can bridge`, async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupeOneToOne.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it('Matrix DM can bridge', async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge(fixture.troupeMatrixDm1.id);
    assert.strictEqual(allowedToBridge, true);
  });

  it('Non-existant room can not bridge', async () => {
    const allowedToBridge = await isGitterRoomIdAllowedToBridge('000000000000000000000000');
    assert.strictEqual(allowedToBridge, false);
  });
});
