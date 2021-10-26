'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const TestError = require('gitter-web-test-utils/lib/test-error');
const MatrixUtils = require('../lib/matrix-utils');
const env = require('gitter-web-env');
const config = env.config;

const serverName = config.get('matrix:bridge:serverName');

describe('matrix-utils', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {
      gravatarImageUrl:
        'https://secure.gravatar.com/avatar/6042a9152ada74d9fb6a0cdce895337e?s=60&d=identicon'
    },
    userWithCapitalUsername1: {
      username: `MyTestUser${fixtureLoader.generateGithubId()}`
    },
    group1: {},
    troupe1: {
      group: 'group1'
    },
    troupePrivate1: {
      group: 'group1',
      users: ['user1'],
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false
      }
    }
  });

  let matrixUtils;
  let matrixBridge;
  beforeEach(() => {
    const clientSpies = {
      resolveRoom: sinon.spy(),
      deleteRoomAlias: sinon.spy(),
      getDirectoryVisibility: sinon.spy(),
      setDirectoryVisibility: sinon.spy()
    };

    const intentSpies = {
      matrixClient: clientSpies,
      getStateEvent: sinon.spy(),
      sendStateEvent: sinon.spy(),
      sendMessage: sinon.spy(() => ({
        event_id: `$${fixtureLoader.generateGithubId()}:localhost`
      })),
      createRoom: sinon.spy(() => ({
        room_id: `!${fixtureLoader.generateGithubId()}:localhost`
      })),
      createAlias: sinon.spy(),
      getProfileInfo: sinon.spy(() => ({})),
      setRoomAvatar: sinon.spy(),
      setDisplayName: sinon.spy(),
      uploadContent: sinon.spy(() => 'mxc://12345'),
      setAvatarUrl: sinon.spy()
    };

    matrixBridge = {
      getIntent: sinon.spy(() => intentSpies)
    };

    matrixUtils = new MatrixUtils(matrixBridge);
  });

  describe('getOrCreateMatrixRoomByGitterRoomId', () => {
    it('creates Matrix room for a unbridged Gitter room', async () => {
      const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(
        fixture.troupe1.id
      );

      assert(matrixRoomId);

      // Room is created for something that hasn't been bridged before
      assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);
    });

    it('returns existing Matrix room for bridged Gitter room', async () => {
      const matrixRoomId1 = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(
        fixture.troupe1.id
      );
      const matrixRoomId2 = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(
        fixture.troupe1.id
      );

      assert(matrixRoomId1);
      assert(matrixRoomId2);
      assert.strictEqual(matrixRoomId1, matrixRoomId2);

      // Room is created for something that hasn't been bridged before
      assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);
    });

    it('creates Matrix room for a unbridged Gitter room', async () => {
      try {
        await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(fixture.troupePrivate1.id);
        assert.fail(new TestError('expected Matrix room creation to fail for private room'));
      } catch (err) {
        if (err instanceof TestError) {
          throw err;
        }

        assert.ok(err);
      }
    });
  });

  describe('getOrCreateMatrixUserByGitterUserId', () => {
    it('creates Matrix user for a unbridged Gitter user', async () => {
      const mxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(fixture.user1.id);

      assert(mxid);

      assert.strictEqual(matrixBridge.getIntent.callCount, 2);
      assert.deepEqual(matrixBridge.getIntent.getCall(0).args, [
        `@${fixture.user1.username}-${fixture.user1.id}:${serverName}`
      ]);
      assert.strictEqual(matrixBridge.getIntent().setDisplayName.callCount, 1);
      // Don't worry about testing the avatar here.
      // It tries to download the URL and we probably don't want to worry about flakey request in CI
      //assert.strictEqual(matrixBridge.getIntent().setAvatarUrl.callCount, 1);
      //assert.strictEqual(matrixBridge.getIntent().setAvatarUrl.getCall(0).args[0], 'mxc://12345');
    });

    it('returns existing Matrix user for bridged Gitter user', async () => {
      const mxid1 = await matrixUtils.getOrCreateMatrixUserByGitterUserId(fixture.user1.id);
      const mxid2 = await matrixUtils.getOrCreateMatrixUserByGitterUserId(fixture.user1.id);

      assert(mxid1);
      assert(mxid2);
      assert.strictEqual(mxid1, mxid2);
    });

    it('lowercases Gitter username for MXID', async () => {
      const mxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
        fixture.userWithCapitalUsername1.id
      );

      assert.strictEqual(mxid, mxid.toLowerCase());
    });

    it('throws when Gitter user does not exist', async () => {
      try {
        await matrixUtils.getOrCreateMatrixUserByGitterUserId('does-not-exist-id');
        assert.fail(
          new TestError('expected error to be thrown because Gitter user does not exist')
        );
      } catch (err) {
        if (err instanceof TestError) {
          throw err;
        }

        assert.ok(err);
      }
    });
  });

  describe('ensureCorrectMxidProfile', () => {
    it('throws when Gitter user does not exist', async () => {
      try {
        await matrixUtils.ensureCorrectMxidProfile(undefined, fixture.user1.id);
        assert.fail(
          new TestError('expected error to be thrown because Gitter user does not exist')
        );
      } catch (err) {
        if (err instanceof TestError) {
          throw err;
        }

        assert.ok(err);
      }
    });
  });
});
