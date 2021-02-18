'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

const {
  isGitterRoomIdAllowedToBridge,
  getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid
} = require('../lib/gitter-utils');
const store = require('../lib/store');

const MXID = '@bob:matrix.org';

describe('gitter-utils', () => {
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

  describe('isGitterRoomIdAllowedToBridge', () => {
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

  describe('getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid', () => {
    it('creates Gitter room for new DM', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;

      const newDmRoom = await getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        matrixRoomId,
        fixture.user1.id,
        MXID
      );

      // Room is created for something that hasn't been bridged before
      assert(newDmRoom);
      assert.strictEqual(newDmRoom.lcUri, `matrix/${fixture.user1.id}/${MXID}`);

      // Check that the new room has a persisted bridged entry
      const gitterRoomId = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
      assert(gitterRoomId);
    });

    it('returns existing room', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      await store.storeBridgedRoom(fixture.troupe1._id, matrixRoomId);

      const dmRoom = await getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        matrixRoomId,
        fixture.user1.id,
        MXID
      );

      assert(dmRoom);
      assert.strictEqual(dmRoom.lcUri, fixture.troupe1.lcUri);
    });

    it('creates new Gitter room even when we already have a bridged entry but the Gitter room does not exist', async () => {
      // Store a bridged room entry but the Gitter room does not exist
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      await store.storeBridgedRoom(mongoUtils.createIdForTimestampString(Date.now()), matrixRoomId);

      const dmRoom = await getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        matrixRoomId,
        fixture.user1.id,
        MXID
      );

      assert(dmRoom);
      assert.strictEqual(dmRoom.lcUri, `matrix/${fixture.user1.id}/${MXID}`);
    });
  });
});
