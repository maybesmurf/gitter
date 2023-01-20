'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';

const debug = require('debug')('gitter:tests:matrix-membership-and-pl-bridging-tests');
const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');
const request = require('supertest');

const env = require('gitter-web-env');
const config = env.config;
const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);

const chatService = require('gitter-web-chats');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const { ROOM_ADMIN_POWER_LEVEL } = require('gitter-web-matrix-bridge/lib/constants');
const RethrownError = require('gitter-web-matrix-bridge/lib/rethrown-error');

const matrixUtils = new MatrixUtils(matrixBridge);

const app = require('../../server/web');

const TEST_WAIT_TIMEOUT_MS = 5000;

async function setupMatrixRoomWithFakeAdminsForGitterRoomId({
  gitterRoomId,
  fakeAdminGitterUserId
}) {
  assert(gitterRoomId);
  assert(fakeAdminGitterUserId);

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);

  // Add an extra room admin to the Matrix power-levels that isn't actually an
  // admin of the Gitter room. We will make sure this user isn't in the power levels
  // after we run the sync.
  const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
    fakeAdminGitterUserId
  );
  await matrixUtils.addAdminToMatrixRoomId({ mxid: gitterUserMxid, matrixRoomId });

  // Sanity check that the admin was actually added
  const bridgeIntent = matrixBridge.getIntent();
  const currentPowerLevelContent = await bridgeIntent.getStateEvent(
    matrixRoomId,
    'm.room.power_levels'
  );
  debug(
    `Before matrixRoomId=${matrixRoomId} powerLevelContent=${JSON.stringify(
      currentPowerLevelContent,
      null,
      2
    )}`
  );

  const actualPowerLevel = (currentPowerLevelContent.users || {})[gitterUserMxid];
  assert(
    actualPowerLevel === ROOM_ADMIN_POWER_LEVEL,
    `Expected power level for ${gitterUserMxid} to be ${ROOM_ADMIN_POWER_LEVEL} but was actually ${actualPowerLevel}:\n${JSON.stringify(
      currentPowerLevelContent,
      null,
      2
    )}`
  );

  return matrixRoomId;
}

async function ensureMatrixRoomIdPowerLevelsAreCorrect({
  matrixRoomId,
  expectedAdminGitterUserIds,
  denyAdminGitterUserIds
}) {
  assert(matrixRoomId);
  assert(expectedAdminGitterUserIds);
  assert(denyAdminGitterUserIds);

  const bridgeIntent = matrixBridge.getIntent();
  const currentPowerLevelContent = await bridgeIntent.getStateEvent(
    matrixRoomId,
    'm.room.power_levels'
  );
  // debug(
  //   `After matrixRoomId=${matrixRoomId} -> powerLevelContent=${JSON.stringify(
  //     currentPowerLevelContent,
  //     null,
  //     2
  //   )}`
  // );

  // Make sure only expected people appear in the power levels
  for (const expectedAdminGitterUserId of expectedAdminGitterUserIds) {
    const adminUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      expectedAdminGitterUserId
    );

    const actualPowerLevel = (currentPowerLevelContent.users || {})[adminUserMxid];
    assert.strictEqual(
      actualPowerLevel,
      ROOM_ADMIN_POWER_LEVEL,
      `Expected power level for ${adminUserMxid} to be ${ROOM_ADMIN_POWER_LEVEL} but was actually ${actualPowerLevel}:\n${JSON.stringify(
        currentPowerLevelContent,
        null,
        2
      )}`
    );
  }

  // Make sure no one from the deny list is in the power levels
  for (const denyAdminGitterUserId of denyAdminGitterUserIds) {
    const denyAdminUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      denyAdminGitterUserId
    );

    const actualPowerLevel = (currentPowerLevelContent.users || {})[denyAdminUserMxid];
    assert.strictEqual(
      actualPowerLevel,
      undefined,
      `${denyAdminUserMxid} should not be in the power levels at all\n${JSON.stringify(
        currentPowerLevelContent,
        null,
        2
      )}`
    );
  }
}

async function waitUntilTimeoutOrSuccess(asyncTask, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let done = false;
    let lastError;
    let numAttempts = 0;
    setTimeout(() => {
      done = true;
      reject(
        new RethrownError(
          `waitUntilTimeoutOrSuccess(...) tried to run the async task ${numAttempts} times but it never completed successfully. The last error thrown was`,
          lastError
        )
      );
    }, timeoutMs);

    do {
      try {
        const returnedValue = await asyncTask();
        resolve(returnedValue);
        done = true;
      } catch (err) {
        lastError = err;
      } finally {
        numAttempts++;
      }
    } while (!done);
  });
}

describe('Gitter -> Matrix briding power-levels e2e', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {
      accessToken: 'web-internal'
    },
    user2: {
      accessToken: 'web-internal'
    },
    userAdmin1: {
      accessToken: 'web-internal'
    },
    userAdminToAdd1: {
      accessToken: 'web-internal'
    },
    userWhoShouldNotBeAdmin1: {
      accessToken: 'web-internal'
    },
    group1: {},
    troupe1: {
      group: 'group1',
      users: ['user1', 'userAdmin1'],
      securityDescriptor: {
        members: 'PUBLIC',
        admins: 'MANUAL',
        public: true,
        extraAdmins: ['userAdmin1']
      }
    },
    troupePrivate1: {
      group: 'group1',
      users: ['user1', 'userAdmin1'],
      securityDescriptor: {
        members: 'INVITE',
        admins: 'MANUAL',
        public: false,
        extraAdmins: ['userAdmin1']
      }
    },
    troupeOneToOne: {
      oneToOne: true,
      users: ['user1', 'user2']
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
        return `${fixtureKey}: ${fixture[fixtureKey].username} (${fixture[fixtureKey].id})`;
      });
    debug(`Fixture map of users:\n${userFixtureDebugStrings.join(' - ')}\n`);
  });

  afterEach(async () => {
    if (stopBridge) {
      await stopBridge();
    }
  });

  it(`A patch to a room's \`sd.extraAdmins\` updates power levels`, async () => {
    const matrixRoomId = await setupMatrixRoomWithFakeAdminsForGitterRoomId({
      gitterRoomId: fixture.troupe1.id,
      fakeAdminGitterUserId: fixture.userWhoShouldNotBeAdmin1.id
    });

    // Trigger a `room.sd` patch change (meaning only the `extraAdmins` changed) by
    // adding another admin
    await request(app)
      .post(`/api/v1/rooms/${fixture.troupe1.id}/security/extraAdmins`)
      .send({ id: fixture.userAdminToAdd1.id })
      .set('Authorization', `Bearer ${fixture.userAdmin1.accessToken}`)
      .expect(200);

    // Since we're using the async out-of-loop Gitter event-listeners to listen
    // for the security descriptor change to come through and bridge we just have to wait
    // until the test times out
    await waitUntilTimeoutOrSuccess(async () => {
      // Ensure power levels look as expected
      await ensureMatrixRoomIdPowerLevelsAreCorrect({
        matrixRoomId,
        expectedAdminGitterUserIds: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id],
        denyAdminGitterUserIds: [fixture.userWhoShouldNotBeAdmin1.id]
      });
    }, TEST_WAIT_TIMEOUT_MS);
  });
});
