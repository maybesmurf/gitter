'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';

const env = require('gitter-web-env');
const config = env.config;

const assert = require('assert');
const request = require('supertest');
const fixtureUtils = require('gitter-web-test-utils/lib/fixture-utils');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');
const registerTestSynapseUser = require('./utils/register-test-synapse-user');
const util = require('util');
const requestLib = util.promisify(require('request'));
const urlJoin = require('url-join');

const installBridge = require('gitter-web-matrix-bridge');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');

const app = require('../../server/web');

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const bridgePortFromConfig = config.get('matrix:bridge:applicationServicePort');

describe('Gitter <-> Matrix bridging e2e', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {
      accessToken: 'web-internal'
    },
    user2: {
      accessToken: 'web-internal'
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
    },
    troupeOneToOne: {
      oneToOne: true,
      users: ['user1', 'user2']
    }
  });

  //let someMatrixUserId;
  let someMatrixUserAccessToken;
  let stopBridge;
  before(async () => {
    await ensureMatrixFixtures();

    stopBridge = await installBridge(bridgePortFromConfig + 1);

    const localPart = fixtureUtils.generateUsername().slice(1);
    //someMatrixUserId = `@${localPart}:${serverName}`;
    const res = await registerTestSynapseUser(localPart);
    someMatrixUserAccessToken = res.access_token;
    assert(someMatrixUserAccessToken);
  });

  after(async () => {
    if (stopBridge) {
      await stopBridge();
    }
  });

  it('bridges message to Matrix in public Gitter room', async () => {
    const messageText = 'foo 123 baz';
    // Send a message in a public room which should trigger the bridged Matrix
    // room creation and send the message in the room.
    const messageSendRes = await request(app)
      .post(`/api/v1/rooms/${fixture.troupe1.id}/chatMessages`)
      .send({ text: messageText })
      .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
      .expect(200);

    // Since we're using the async out-of-loop Gitter event-listeners to listen
    // for the new chat message to come through and bridge we just have to wait
    // until we see that the Matrix room is created and stored
    let matrixRoomId;
    do {
      matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(fixture.troupe1.id);
    } while (!matrixRoomId);
    // And wait for the initial message to be bridged which triggered this whole process
    assert(messageSendRes.body.id);
    let matrixEventId;
    do {
      matrixEventId = await matrixStore.getBridgedMessageEntryByGitterMessageId(
        messageSendRes.body.id
      );
    } while (!matrixEventId);

    // Try to join the room from some Matrix user's perspective. We should be able to get in!
    const joinRes = await requestLib({
      method: 'POST',
      uri: urlJoin(homeserverUrl, `/_matrix/client/r0/rooms/${matrixRoomId}/join`),
      json: true,
      headers: {
        Authorization: `Bearer ${someMatrixUserAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: {}
    });
    assert.strictEqual(
      joinRes.statusCode,
      200,
      `Expected to be able to join Matrix room (which should be public) for bridged public Gitter room, joinRes.body=${JSON.stringify(
        joinRes.body
      )}`
    );

    // Make sure we can see the Gitter message in the matrix room as well
    const messageRes = await requestLib({
      method: 'GET',
      uri: urlJoin(homeserverUrl, `/_matrix/client/r0/rooms/${matrixRoomId}/messages?dir=b`),
      json: true,
      headers: {
        Authorization: `Bearer ${someMatrixUserAccessToken}`,
        'Content-Type': 'application/json'
      }
    });
    assert.strictEqual(
      messageRes.statusCode,
      200,
      `Expected to be able to read messages in public Matrix room, messageRes.body=${JSON.stringify(
        messageRes.body
      )}`
    );
    assert.strictEqual(
      messageRes.body.chunk.filter(event => event.type === 'm.room.message')[0].content.body,
      messageText,
      `Expected the latest message in the room to match our Gitter message we sent initially, messageRes.body=${JSON.stringify(
        messageRes.body
      )}`
    );
  });

  it('bridges message to Matrix in private Gitter room', async () => {
    const messageText = 'foo 123 baz';
    // Send a message in a public room which should trigger the bridged Matrix
    // room creation and send the message in the room.
    const messageSendRes = await request(app)
      .post(`/api/v1/rooms/${fixture.troupePrivate1.id}/chatMessages`)
      .send({ text: messageText })
      .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
      .expect(200);

    // Since we're using the async out-of-loop Gitter event-listeners to listen
    // for the new chat message to come through and bridge we just have to wait
    // until we see that the Matrix room is created and stored
    let matrixRoomId;
    do {
      matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(fixture.troupePrivate1.id);
    } while (!matrixRoomId);
    // And wait for the initial message to be bridged which triggered this whole process
    assert(messageSendRes.body.id);
    let matrixEventId;
    do {
      matrixEventId = await matrixStore.getBridgedMessageEntryByGitterMessageId(
        messageSendRes.body.id
      );
    } while (!matrixEventId);

    // Try to join the room from some Matrix user's perspective. We shouldn't be able to get in!
    const joinRes = await requestLib({
      method: 'POST',
      uri: urlJoin(homeserverUrl, `/_matrix/client/r0/rooms/${matrixRoomId}/join`),
      json: true,
      headers: {
        Authorization: `Bearer ${someMatrixUserAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: {}
    });
    assert.strictEqual(
      joinRes.statusCode,
      403,
      `Expected not to be able to join Matrix room (which should be private) for bridged private Gitter room, joinRes.body=${JSON.stringify(
        joinRes.body
      )}`
    );
  });

  it('bridges message to Matrix in ONE_TO_ONE Gitter room', async () => {
    const messageText = 'foo 123 baz';
    // Send a message in a public room which should trigger the bridged Matrix
    // room creation and send the message in the room.
    const messageSendRes = await request(app)
      .post(`/api/v1/rooms/${fixture.troupeOneToOne.id}/chatMessages`)
      .send({ text: messageText })
      .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
      .expect(200);

    // Since we're using the async out-of-loop Gitter event-listeners to listen
    // for the new chat message to come through and bridge we just have to wait
    // until we see that the Matrix room is created and stored
    let matrixRoomId;
    do {
      matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(fixture.troupeOneToOne.id);
    } while (!matrixRoomId);
    // And wait for the initial message to be bridged which triggered this whole process
    assert(messageSendRes.body.id);
    let matrixEventId;
    do {
      matrixEventId = await matrixStore.getBridgedMessageEntryByGitterMessageId(
        messageSendRes.body.id
      );
    } while (!matrixEventId);

    // Try to join the room from some Matrix user's perspective. We shouldn't be able to get in!
    const joinRes = await requestLib({
      method: 'POST',
      uri: urlJoin(homeserverUrl, `/_matrix/client/r0/rooms/${matrixRoomId}/join`),
      json: true,
      headers: {
        Authorization: `Bearer ${someMatrixUserAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: {}
    });
    assert.strictEqual(
      joinRes.statusCode,
      403,
      `Expected not to be able to join Matrix room (which should be private) for bridged ONE_TO_ONE Gitter room, joinRes.body=${JSON.stringify(
        joinRes.body
      )}`
    );
  });
});
