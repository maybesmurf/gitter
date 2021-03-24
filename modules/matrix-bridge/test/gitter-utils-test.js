'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

const GitterUtils = require('../lib/gitter-utils');
const store = require('../lib/store');

const MXID = '@bob:matrix.org';

describe('gitter-utils', () => {
  const fixture = fixtureLoader.setupEach({
    userBridge1: {},
    user1: {},
    group1: {},
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

  let gitterUtils;
  beforeEach(() => {
    gitterUtils = new GitterUtils(fixture.userBridge1.username, fixture.group1.uri);
  });

  describe('getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid', () => {
    it('creates Gitter room for new DM', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;

      const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
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
      // TODO
    });

    it('is able to update the matrixRoomId in the bridged room entry and return existing Gitter room', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;

      // Create the Gitter DM room
      const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        matrixRoomId,
        fixture.user1.id,
        MXID
      );

      assert(newDmRoom);

      // Check that the new Gitter room has a persisted bridged entry for the given matrixRoomId
      const storedGitterRoomId1 = await store.getGitterRoomIdByMatrixRoomId(matrixRoomId);
      assert(mongoUtils.objectIDsEqual(storedGitterRoomId1, newDmRoom._id));

      // Try to get the DM with the same users involved but a different Matrix room ID.
      // This mimics a Matrix user starting a new DM conversation with the same Gitter user
      const differntMatrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      const dmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        differntMatrixRoomId,
        fixture.user1.id,
        MXID
      );

      assert(dmRoom);

      // Check that the existing Gitter room is connected to the new Matrix DM room
      const storedGitterRoomId2 = await store.getGitterRoomIdByMatrixRoomId(differntMatrixRoomId);
      assert(mongoUtils.objectIDsEqual(storedGitterRoomId2, dmRoom._id));
    });
  });
});
