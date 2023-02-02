'use strict';

const debug = require('debug')('gitter:tests:matrix-sync-membership-tests');
const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');

const env = require('gitter-web-env');
const config = env.config;
const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const {
  syncMatrixRoomMembershipFromGitterRoom
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-room-membership-sync');

const matrixUtils = new MatrixUtils(matrixBridge);

async function setupMatrixRoomWithFakeMembershipForGitterRoomId({
  gitterRoomId,
  gitterUserIdsToAddToMatrixRoom
}) {
  assert(gitterRoomId);
  assert(gitterUserIdsToAddToMatrixRoom);

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  const matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );

  for (const gitterUserIdToJoin of gitterUserIdsToAddToMatrixRoom) {
    const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      gitterUserIdToJoin
    );
    const intent = matrixBridge.getIntent(gitterUserMxid);
    await intent.join(matrixRoomId);
    await intent.join(matrixHistoricalRoomId);
  }

  debug(`matrixRoomId=${matrixRoomId}, matrixHistoricalRoomId=${matrixHistoricalRoomId}`);
  return { matrixRoomId, matrixHistoricalRoomId };
}

// Use the wrapping `ensureMatrixRoomIdPowerLevelsAreCorrect` function in your tests instead
async function ensureMatrixRoomMembershipIsCorrect({
  matrixRoomId,
  roomDescriptor,
  expectedGitterUserIds,
  denyGitterUserIds
}) {
  assert(matrixRoomId);
  assert(roomDescriptor);
  assert(expectedGitterUserIds);
  assert(denyGitterUserIds);

  const matrixMemberEvents = await matrixUtils.getRoomMembers({
    matrixRoomId,
    membership: 'join'
  });
  const mxidJoinedMap = new Map();
  for (const matrixMemberEvent of matrixMemberEvents) {
    const mxid = matrixMemberEvent.state_key;
    mxidJoinedMap.set(mxid, true);
  }

  // Make sure only expected people appear in the membership
  for (const expectedGitterUserId of expectedGitterUserIds) {
    const userMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(expectedGitterUserId);
    assert.strictEqual(
      mxidJoinedMap.get(userMxid),
      true,
      `Expected ${userMxid} to be joined to ${matrixRoomId} (${roomDescriptor}) but only these users were joined ${JSON.stringify(
        Array.from(mxidJoinedMap.keys())
      )}`
    );
  }

  // Make sure no one from the deny list is in the membership
  for (const denyGitterUserId of denyGitterUserIds) {
    const denyUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(denyGitterUserId);
    assert.strictEqual(
      mxidJoinedMap.get(denyUserMxid),
      undefined,
      `Expected ${denyUserMxid} *NOT* to be joined to ${matrixRoomId} (${roomDescriptor}) but it was listed alongside these members ${JSON.stringify(
        Array.from(mxidJoinedMap.keys())
      )}`
    );
  }
}

describe('Gitter -> Matrix syncing room membership e2e', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {
      accessToken: 'web-internal'
    },
    userToAddToMatrixRoom: {
      accessToken: 'web-internal'
    },
    userWhoShouldNotBeInMatrixRoom: {
      accessToken: 'web-internal'
    },
    group1: {},
    troupe1: {
      group: 'group1',
      users: ['user1', 'userToAddToMatrixRoom']
    },
    troupePrivate1: {
      group: 'group1',
      users: ['user1', 'userToAddToMatrixRoom'],
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false
      }
    }
  });

  before(async () => {
    await ensureMatrixFixtures();
  });

  let stopBridge;
  beforeEach(async () => {
    stopBridge = await installBridge(bridgePortFromConfig + 1);

    const userFixtureDebugStrings = Object.keys(fixture)
      .filter(fixtureKey => fixtureKey.startsWith('user'))
      .map(fixtureKey => {
        return `\n - ${fixtureKey}: ${fixture[fixtureKey].username} (${fixture[fixtureKey].id})`;
      });
    debug(`Fixture map of users:${userFixtureDebugStrings.join('')}`);
  });

  afterEach(async () => {
    if (stopBridge) {
      await stopBridge();
    }
  });

  it(`In a public room: non-members removed, members added (except members not added to historical room)`, async () => {
    const fixtureRoom = fixture.troupe1;
    const {
      matrixRoomId,
      matrixHistoricalRoomId
    } = await setupMatrixRoomWithFakeMembershipForGitterRoomId({
      gitterRoomId: fixtureRoom.id,
      gitterUserIdsToAddToMatrixRoom: [
        // This person is member of the Gitter room that should be in the Matrix room.
        // `fixture.userToAddToMatrixRoom` is also in the Gitter room and should be in
        // the Matrix room but we will test that our sync script corrects this mistake.
        fixture.user1.id,
        // Add an extra Matrix room member that isn't actually a member of the Gitter room. We
        // will make sure this user isn't in membership after we run the sync.
        fixture.userWhoShouldNotBeInMatrixRoom.id
      ]
    });

    // Sync room memberhip to historical and "live" Matrix rooms
    await syncMatrixRoomMembershipFromGitterRoom(fixtureRoom);

    // Ensure power levels look as expected
    await ensureMatrixRoomMembershipIsCorrect({
      matrixRoomId,
      roomDescriptor: '"live"',
      expectedGitterUserIds: [fixture.user1.id, fixture.userToAddToMatrixRoom.id],
      denyGitterUserIds: [fixture.userWhoShouldNotBeInMatrixRoom.id]
    });
    await ensureMatrixRoomMembershipIsCorrect({
      matrixRoomId: matrixHistoricalRoomId,
      roomDescriptor: 'historical',
      expectedGitterUserIds: [
        fixture.user1.id
        // Exception: This user wasn't added to the historical room automaticall because they can always join it later themselves since it's a public room
        //
        //fixture.userToAddToMatrixRoom.id
      ],
      denyGitterUserIds: [fixture.userWhoShouldNotBeInMatrixRoom.id]
    });
  });

  it(`In a private room: non-members removed, members added for both the "live" and historical Matrix rooms`, async () => {
    const fixtureRoom = fixture.troupePrivate1;
    const {
      matrixRoomId,
      matrixHistoricalRoomId
    } = await setupMatrixRoomWithFakeMembershipForGitterRoomId({
      gitterRoomId: fixtureRoom.id,
      gitterUserIdsToAddToMatrixRoom: [
        // This person is member of the Gitter room that should be in the Matrix room.
        // `fixture.userToAddToMatrixRoom` is also in the Gitter room and should be in
        // the Matrix room but we will test that our sync script corrects this mistake.
        fixture.user1.id,
        // Add an extra Matrix room member that isn't actually a member of the Gitter room. We
        // will make sure this user isn't in membership after we run the sync.
        fixture.userWhoShouldNotBeInMatrixRoom.id
      ]
    });

    // Sync room memberhip to historical and "live" Matrix rooms
    await syncMatrixRoomMembershipFromGitterRoom(fixtureRoom);

    // Ensure power levels look as expected
    await ensureMatrixRoomMembershipIsCorrect({
      matrixRoomId,
      roomDescriptor: '"live"',
      expectedGitterUserIds: [fixture.user1.id, fixture.userToAddToMatrixRoom.id],
      denyGitterUserIds: [fixture.userWhoShouldNotBeInMatrixRoom.id]
    });
    await ensureMatrixRoomMembershipIsCorrect({
      matrixRoomId: matrixHistoricalRoomId,
      roomDescriptor: 'historical',
      expectedGitterUserIds: [fixture.user1.id, fixture.userToAddToMatrixRoom.id],
      denyGitterUserIds: [fixture.userWhoShouldNotBeInMatrixRoom.id]
    });
  });
});
