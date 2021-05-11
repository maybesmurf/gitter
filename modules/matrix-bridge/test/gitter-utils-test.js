'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

const GitterUtils = require('../lib/gitter-utils');

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

  let matrixBridge;
  let gitterUtils;
  beforeEach(() => {
    const intentSpies = {
      sendMessage: sinon.spy()
    };
    matrixBridge = {
      getIntent: (/*userId*/) => intentSpies
    };

    gitterUtils = new GitterUtils(matrixBridge, fixture.userBridge1.username, fixture.group1.uri);
  });

  describe('getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid', () => {
    it('creates Gitter room for new DM', async () => {
      const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
        fixture.user1,
        MXID
      );

      // Room is created for something that hasn't been bridged before
      assert(newDmRoom);
      assert.strictEqual(newDmRoom.lcUri, `matrix/${fixture.user1.id}/${MXID}`);
    });

    it('returns existing room', async () => {
      // Create the Gitter DM room
      const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
        fixture.user1,
        MXID
      );

      assert(newDmRoom);

      // Try to get the same already existing room
      const dmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
        fixture.user1,
        MXID
      );

      assert(dmRoom);

      // Make sure the room ID's are the same
      assert(mongoUtils.objectIDsEqual(newDmRoom._id, dmRoom._id));
    });
  });
});
