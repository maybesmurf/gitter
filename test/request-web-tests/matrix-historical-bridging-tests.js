'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';

const debug = require('debug')('gitter:tests:matrix-historical-bridging-tests');
const assert = require('assert');
const fixtureUtils = require('gitter-web-test-utils/lib/fixture-utils');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');
const registerTestSynapseUser = require('./utils/register-test-synapse-user');
const { joinMatrixRoom, getMessagesFromMatrixRoom } = require('./utils/matrix-raw-test-utils');
const util = require('util');
const requestLib = util.promisify(require('request'));
const urlJoin = require('url-join');

const env = require('gitter-web-env');
const config = env.config;
const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const bridgePortFromConfig = config.get('matrix:bridge:applicationServicePort');

const persistence = require('gitter-web-persistence');
const chatService = require('gitter-web-chats');
const installBridge = require('gitter-web-matrix-bridge');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('../../scripts/utils/gitter-to-matrix-historical-import/concurrent-queue');

async function assertNotBridgedBefore(gitterRoomId) {
  const matrixRoomIdBefore = await matrixStore.getMatrixRoomIdByGitterRoomId(gitterRoomId);
  assert(
    !matrixRoomIdBefore,
    `We haven't imported anything yet so the Matrix room should not exist yet`
  );
  const matrixHistoricalRoomIdBefore = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
    gitterRoomId
  );
  assert(
    !matrixHistoricalRoomIdBefore,
    `We haven't imported anything yet so the Matrix room should not exist yet`
  );
}

// We could use `gitterToMatrixHistoricalImport(...)` directly here but this also tests out
// some of the mechanics of how the actual worker will run through things.
async function importHistoryFromRooms(roomsToImport) {
  async function* asyncRoomIterable() {
    for (let i = 0; i < roomsToImport.length; i++) {
      const roomToImport = roomsToImport[i];
      yield await Promise.resolve(roomToImport);
    }
  }

  const concurrentQueue = new ConcurrentQueue({
    concurrency: 1,
    itemIdGetterFromItem: gitterRoom => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;
      return String(gitterRoomId);
    }
  });

  await concurrentQueue.processFromGenerator(
    asyncRoomIterable(),
    // Room filter
    gitterRoom => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;
      return true;
    },
    // Process function
    async ({ value: gitterRoom, laneIndex }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;
      await gitterToMatrixHistoricalImport(gitterRoomId);
    }
  );

  return concurrentQueue;
}

async function assertCanJoinMatrixRoom({
  matrixRoomId,
  matrixHistoricalRoomId,
  matrixAccessToken,
  expectedStatusCode,
  descriptionSecurityType, // ['public'|'private],
  descriptionPerspective // "a random user"
}) {
  const joinRes = await joinMatrixRoom(matrixRoomId, matrixAccessToken);
  assert.strictEqual(
    joinRes.statusCode,
    expectedStatusCode,
    `Expected to be able to join Matrix room (${matrixRoomId} which should be ${descriptionSecurityType}) from the perspective of ${descriptionPerspective} for bridged Gitter room, joinRes.body=${JSON.stringify(
      joinRes.body
    )}`
  );
  const joinHistoricalRes = await joinMatrixRoom(matrixHistoricalRoomId, matrixAccessToken);
  assert.strictEqual(
    joinHistoricalRes.statusCode,
    expectedStatusCode,
    `Expected to be able to join historical Matrix room (${matrixHistoricalRoomId} which should be ${descriptionSecurityType}) from the perspective of ${descriptionPerspective} for bridged Gitter room, joinHistoricalRes.body=${JSON.stringify(
      joinHistoricalRes.body
    )}`
  );
}

async function setupMessagesInRoom(gitterRoom, user) {
  const message1 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '1 *one*'
  });
  await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '2 **two**',
    parentId: message1.id
  });
  await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '3 three'
  });

  const message4 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '4 *four*'
  });
  await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '5 **five**',
    parentId: message4.id
  });
  await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '6 six'
  });
  debug('setupMessagesInRoom: Created Gitter messages in room');

  // Since we don't have the main webapp running during the tests, the out-of-band
  // Gitter event-listeners won't be listening and these message sends won't make their
  // way to Matrix via the bridge. We also don't have the bridge running until after we
  // create the Gitter messages.
}

async function assertHistoryInMatrixRoom({ matrixRoomId, matrixAccessToken, expectedMessages }) {
  const messagesRes = await getMessagesFromMatrixRoom({
    matrixRoomId,
    matrixAccessToken,
    dir: 'b',
    limit: 100
  });
  assert.strictEqual(
    messagesRes.statusCode,
    200,
    `Expected to be able to see \`/messages\` Matrix room (${matrixRoomId}, messagesRes.body=${JSON.stringify(
      messagesRes.body
    )}`
  );

  const relevantMessageEvents = messagesRes.body.chunk.filter(event => {
    return event.type === 'm.room.message';
  });

  // Assert the messages match the expected
  assert.strictEqual(relevantMessageEvents.length, expectedMessages.length);

  const messageAssertionMap = {
    1: event => {
      assert.strictEqual(event[0].content.body, '1 *one*');
    },
    2: event => {
      assert.strictEqual(event.content.body, '2 **two**');
      assert(event.content['m.relates_to']['event_id']);
      // Ideally we'd assert these to a certain event_id but it's good enough to see
      // that they are a thread reply of some sort. We can test absolute message
      // formatting elsewhere.
      assert(event.content['m.relates_to']['event_id']);
      assert(event.content['m.relates_to']['m.in_reply_to']['event_id']);
    },
    3: event => {
      assert.strictEqual(event.content.body, '3 three');
    },
    4: event => {
      assert.strictEqual(event[0].content.body, '4 *four*');
    },
    5: event => {
      assert.strictEqual(event.content.body, '5 **five**');
      assert(event.content['m.relates_to']['event_id']);
      // Ideally we'd assert these to a certain event_id but it's good enough to see
      // that they are a thread reply of some sort. We can test absolute message
      // formatting elsewhere.
      assert(event.content['m.relates_to']['event_id']);
      assert(event.content['m.relates_to']['m.in_reply_to']['event_id']);
    },
    6: event => {
      assert.strictEqual(event.content.body, '6 six');
    }
  };

  for (let i = 0; i < expectedMessages; i++) {
    const nextExpectedMessageKey = expectedMessages[i];

    const assertionFunc = messageAssertionMap[nextExpectedMessageKey];
    if (!assertionFunc) {
      throw new Error(
        `Unknown message ${nextExpectedMessageKey} in expectedMessages=${expectedMessages}`
      );
    }
    assertionFunc(relevantMessageEvents[i]);
  }
}

describe('Gitter -> Matrix historical import e2e', () => {
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

  let someMatrixUserAccessToken;
  let stopBridge;
  before(async () => {
    await ensureMatrixFixtures();
    debug('Ensured that we have the Matrix fixtures in place');

    const localPart = fixtureUtils.generateUsername().slice(1);
    //someMatrixUserId = `@${localPart}:${serverName}`;
    const res = await registerTestSynapseUser(localPart);
    someMatrixUserAccessToken = res.access_token;
    assert(someMatrixUserAccessToken);
    debug('Created random Matrix user to test access with');
  });

  beforeEach(async () => {
    await assertNotBridgedBefore(fixture.troupe1.id);
    await assertNotBridgedBefore(fixture.troupePrivate1.id);
    await assertNotBridgedBefore(fixture.troupeOneToOne.id);
    debug('Asserted that these rooms have not been bridged before');

    await setupMessagesInRoom(fixture.troupe1, fixture.user1);
    await setupMessagesInRoom(fixture.troupePrivate1, fixture.user1);
    await setupMessagesInRoom(fixture.troupeOneToOne, fixture.user1);
    debug('Setup messages in rooms');

    // It's important that this comes after we setup all of the messages in the room
    stopBridge = await installBridge(bridgePortFromConfig + 1);
  });

  after(async () => {
    if (stopBridge) {
      await stopBridge();
    }
  });

  it('imports history to Matrix for public Gitter room', async () => {
    // The function under test
    await importHistoryFromRooms([fixture.troupe1]);

    const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(fixture.troupe1.id);
    const matrixHistoricalRoomId = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
      fixture.troupe1.id
    );

    // Try to join the room from some random Matrix user's perspective. We should be
    // able to get in to a public room!
    await assertCanJoinMatrixRoom({
      matrixRoomId,
      matrixHistoricalRoomId,
      matrixAccessToken: someMatrixUserAccessToken,
      expectedStatusCode: 200,
      descriptionSecurityType: 'public',
      descriptionPerspective: 'a random user'
    });

    // Assert the history
    await assertHistoryInMatrixRoom({
      matrixRoomId: matrixHistoricalRoomId,
      matrixAccessToken: someMatrixUserAccessToken,
      expectedMessages: [1, 2, 3, 4, 5, 6]
    });
  });

  it('imports history to Matrix for private Gitter room', async () => {
    // The function under test
    await importHistoryFromRooms([fixture.troupePrivate1]);

    const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(fixture.troupePrivate1.id);
    const matrixHistoricalRoomId = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
      fixture.troupePrivate1.id
    );

    // Try to join the room from some Matrix user's perspective. We shouldn't be able to get in!
    await assertCanJoinMatrixRoom({
      matrixRoomId,
      matrixHistoricalRoomId,
      matrixAccessToken: someMatrixUserAccessToken,
      expectedStatusCode: 403,
      descriptionSecurityType: 'private',
      descriptionPerspective: 'a random user'
    });

    // Try to join the room from the perpectivate of a user in the private Matrix room.
    // We *should* be able to get in!
    await assertCanJoinMatrixRoom({
      matrixRoomId,
      matrixHistoricalRoomId,
      matrixAccessToken: TODO,
      expectedStatusCode: 200,
      descriptionSecurityType: 'private',
      descriptionPerspective: 'a user in the private room'
    });

    // Assert the history
    await assertHistoryInMatrixRoom({
      matrixRoomId: matrixHistoricalRoomId,
      matrixAccessToken: TODO,
      expectedMessages: [1, 2, 3, 4, 5, 6]
    });
  });

  it('historical room stops and continues in live room');
});
