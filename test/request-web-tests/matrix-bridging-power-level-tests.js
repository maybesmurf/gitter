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

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const { ROOM_ADMIN_POWER_LEVEL } = require('gitter-web-matrix-bridge/lib/constants');
const RethrownError = require('gitter-web-matrix-bridge/lib/rethrown-error');

const matrixUtils = new MatrixUtils(matrixBridge);

const app = require('../../server/web');

const TEST_WAIT_TIMEOUT_MS = 5000;
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

// Use the wrapping `ensureMatrixRoomIdPowerLevelsAreCorrect` function in your tests instead
async function _checkMatrixRoomIdPowerLevelsAreCorrect({
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

async function ensureMatrixRoomIdPowerLevelsAreCorrect({
  matrixRoomId,
  expectedAdminGitterUserIds,
  denyAdminGitterUserIds
}) {
  // Since we're using the async out-of-loop Gitter event-listeners to listen for the
  // security descriptor change to come through and bridge changes to Matrix we just
  // have to wait until the test times out or the assertions succeed.
  return await waitUntilTimeoutOrSuccess(async () => {
    return await _checkMatrixRoomIdPowerLevelsAreCorrect({
      matrixRoomId,
      expectedAdminGitterUserIds,
      denyAdminGitterUserIds
    });
  }, TEST_WAIT_TIMEOUT_MS);
}

describe('Gitter -> Matrix briding power-levels e2e', () => {
  fixtureLoader.ensureIntegrationEnvironment(
    // This is a public member of `GITTER_INTEGRATION_ORG`
    '#integrationCollabUser1',
    'GITTER_INTEGRATION_ORG',
    'GITTER_INTEGRATION_ORG_ID'
  );

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

    userIntegration1: '#integrationCollabUser1',
    groupBackedByGitHub2: {
      securityDescriptor: {
        type: 'GH_ORG',
        admins: 'GH_ORG_MEMBER',
        members: 'PUBLIC',
        public: true,
        linkPath: fixtureLoader.GITTER_INTEGRATION_ORG,
        externalId: fixtureLoader.GITTER_INTEGRATION_ORG_ID,
        extraAdmins: []
      }
    },
    troupeBackedByGroup2: {
      group: 'groupBackedByGitHub2',
      users: ['user1', 'userAdmin1', 'userIntegration1'],
      securityDescriptor: {
        members: 'PUBLIC',
        admins: 'MANUAL',
        public: true,
        extraAdmins: ['userAdmin1']
      }
    },

    group3: {
      securityDescriptor: {
        type: null,
        members: 'PUBLIC',
        admins: 'MANUAL',
        public: true,
        extraAdmins: ['userAdmin1']
      }
    },
    troupe3Inheriting: {
      group: 'group3',
      users: ['user1'],
      securityDescriptor: {
        type: 'GROUP',
        internalId: 'group3',
        members: 'PUBLIC',
        public: true,
        admins: 'GROUP_ADMIN',
        extraAdmins: []
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

  describe('Gitter room.sd changes update power levels in Matrix room', () => {
    it(
      `Adding another Gitter room admin will emit a \`room.sd\` \`patch\` event ` +
        `about \`sd.extraAdmins\` and will update Matrix power levels`,
      async () => {
        const fixtureRoom = fixture.troupe1;
        const matrixRoomId = await setupMatrixRoomWithFakeAdminsForGitterRoomId({
          gitterRoomId: fixtureRoom.id,
          fakeAdminGitterUserId: fixture.userWhoShouldNotBeAdmin1.id
        });

        // Trigger a `room.sd` patch event (meaning only the `sd.extraAdmins` changed) by
        // adding another admin and using the `/security/extraAdmins` endpoint
        //
        // We expect this to use the shortcut method of updating admins where it only
        // looks over specified `extraAdmins` although we don't assert how the bridge gets
        // things done.
        await request(app)
          .post(`/api/v1/rooms/${fixtureRoom.id}/security/extraAdmins`)
          .send({ id: fixture.userAdminToAdd1.id })
          .set('Authorization', `Bearer ${fixture.userAdmin1.accessToken}`)
          .expect(200);

        // Ensure power levels look as expected
        await ensureMatrixRoomIdPowerLevelsAreCorrect({
          matrixRoomId,
          expectedAdminGitterUserIds: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id],
          denyAdminGitterUserIds: [fixture.userWhoShouldNotBeAdmin1.id]
        });
      }
    );

    it(
      `Updating the whole room security descriptor but still using manual admins ` +
        `will emit an \`room.sd\` \`update\` event and update Matrix power levels`,
      async () => {
        const fixtureRoom = fixture.troupe1;
        const matrixRoomId = await setupMatrixRoomWithFakeAdminsForGitterRoomId({
          gitterRoomId: fixtureRoom.id,
          fakeAdminGitterUserId: fixture.userWhoShouldNotBeAdmin1.id
        });

        // Trigger a `room.sd` update event (meaning only the whole `sd` changed) by
        // adding another admin and using the `/security` endpoint.
        //
        // We expect this to use the shortcut method of updating admins where it only
        // looks over specified `extraAdmins` although we don't assert how the bridge gets
        // things done.
        await request(app)
          .put(`/api/v1/rooms/${fixtureRoom.id}/security`)
          .send({
            type: null,
            members: 'PUBLIC',
            admins: 'MANUAL',
            extraAdmins: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id]
          })
          .set('Authorization', `Bearer ${fixture.userAdmin1.accessToken}`)
          .expect(200);

        // Ensure power levels look as expected
        await ensureMatrixRoomIdPowerLevelsAreCorrect({
          matrixRoomId,
          expectedAdminGitterUserIds: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id],
          denyAdminGitterUserIds: [fixture.userWhoShouldNotBeAdmin1.id]
        });
      }
    );

    it(
      `Updating the whole room security descriptor and changing \`sd.type\` ` +
        `will emit an \`room.sd\` \`update\` event and update Matrix power levels`,
      async () => {
        const fixtureRoom = fixture.troupeBackedByGroup2;
        const matrixRoomId = await setupMatrixRoomWithFakeAdminsForGitterRoomId({
          gitterRoomId: fixtureRoom.id,
          fakeAdminGitterUserId: fixture.userWhoShouldNotBeAdmin1.id
        });

        // Trigger a `room.sd` update event (meaning only the whole `sd` changed) by
        // adding another admin and using the `/security` endpoint
        //
        // We expect this to use the long-method of updating admins where it only loops
        // over all room members to find admins although we don't assert how the bridge
        // gets things done.
        await request(app)
          .put(`/api/v1/rooms/${fixtureRoom.id}/security`)
          .send({
            type: 'GROUP',
            members: 'PUBLIC',
            admins: 'GROUP_ADMIN',
            extraAdmins: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id]
          })
          .set('Authorization', `Bearer ${fixture.userAdmin1.accessToken}`)
          .expect(200);

        // Ensure power levels look as expected
        await ensureMatrixRoomIdPowerLevelsAreCorrect({
          matrixRoomId,
          expectedAdminGitterUserIds: [
            fixture.userAdmin1.id,
            fixture.userAdminToAdd1.id,
            // This was a user of the room and the room security descriptor was updated to
            // use group permissions which inherit from the GitHub org. So this org member
            // should be an admin of the room now.
            fixture.userIntegration1.id
          ],
          denyAdminGitterUserIds: [fixture.userWhoShouldNotBeAdmin1.id]
        });
      }
    );
  });

  describe('Gitter group.sd changes update power levels in Matrix room', () => {
    it(
      `Updating the whole group security descriptor will update any rooms ` +
        `inheriting admins from the group and update Matrix power levels`,
      async () => {
        const fixtureGroup = fixture.group3;
        const fixtureRoom = fixture.troupe3Inheriting;
        const matrixRoomId = await setupMatrixRoomWithFakeAdminsForGitterRoomId({
          gitterRoomId: fixtureRoom.id,
          fakeAdminGitterUserId: fixture.userWhoShouldNotBeAdmin1.id
        });

        // Trigger a `group.sd` update event
        //
        // We expect all of the rooms that inherit from this group to be updated
        await request(app)
          .put(`/api/v1/groups/${fixtureGroup.id}/security`)
          .send({
            type: null,
            members: 'PUBLIC',
            admins: 'MANUAL',
            extraAdmins: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id]
          })
          .set('Authorization', `Bearer ${fixture.userAdmin1.accessToken}`)
          .expect(200);

        // Ensure power levels look as expected
        await ensureMatrixRoomIdPowerLevelsAreCorrect({
          matrixRoomId,
          expectedAdminGitterUserIds: [fixture.userAdmin1.id, fixture.userAdminToAdd1.id],
          denyAdminGitterUserIds: [fixture.userWhoShouldNotBeAdmin1.id]
        });
      }
    );
  });
});
