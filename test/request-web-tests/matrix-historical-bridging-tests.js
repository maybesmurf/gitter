'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';

const debug = require('debug')('gitter:tests:matrix-historical-bridging-tests');
const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');

const env = require('gitter-web-env');
const config = env.config;
const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);

const chatService = require('gitter-web-chats');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('../../scripts/utils/gitter-to-matrix-historical-import/concurrent-queue');

const matrixUtils = new MatrixUtils(matrixBridge);

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
    (/*gitterRoom*/) => {
      //const gitterRoomId = gitterRoom.id || gitterRoom._id;
      return true;
    },
    // Process function
    async ({ value: gitterRoom /*, laneIndex*/ }) => {
      const gitterRoomId = gitterRoom.id || gitterRoom._id;
      await gitterToMatrixHistoricalImport(gitterRoomId);
    }
  );

  return concurrentQueue;
}

async function assertCanJoinMatrixRoom({
  matrixRoomId,
  matrixHistoricalRoomId,
  mxid,
  expectToJoin,
  descriptionSecurityType, // ['public'|'private],
  descriptionPerspective // "a random user"
}) {
  assert(matrixRoomId);
  assert(matrixHistoricalRoomId);
  assert(mxid);
  assert(expectToJoin === true || expectToJoin === false);
  assert(descriptionSecurityType);
  assert(descriptionPerspective);

  const _canJoinWrapper = async function(matrixRoomId) {
    const intent = matrixBridge.getIntent(mxid);
    try {
      await intent.join(matrixRoomId);
      if (!expectToJoin) {
        throw new Error(
          `We weren't supposed to be able to join (${matrixRoomId} which should be ${descriptionSecurityType}) from the perspective of ${descriptionPerspective} for bridged Gitter room`
        );
      }
    } catch (err) {
      if (expectToJoin) {
        throw new Error(
          `Expected to be able to join Matrix room (${matrixRoomId} which should be ${descriptionSecurityType}) from the perspective of ${descriptionPerspective} for bridged Gitter room, ${err.stack}`
        );
      }
    }
  };

  await _canJoinWrapper(matrixRoomId);
  await _canJoinWrapper(matrixHistoricalRoomId);
}

async function setupMessagesInRoom(gitterRoom, user) {
  const message1 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '1 *one*'
  });
  const message2 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '2 **two**',
    parentId: message1.id
  });
  const message3 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '3 three'
  });

  const message4 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '4 *four*'
  });
  const message5 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '5 **five**',
    parentId: message4.id
  });
  const message6 = await chatService.newChatMessageToTroupe(gitterRoom, user, {
    text: '6 six'
  });
  debug('setupMessagesInRoom: Created Gitter messages in room');

  // Since we don't have the main webapp running during the tests, the out-of-band
  // Gitter event-listeners won't be listening and these message sends won't make their
  // way to Matrix via the bridge. We also don't have the bridge running until after we
  // create the Gitter messages.

  return [message1, message2, message3, message4, message5, message6];
}

async function assertHistoryInMatrixRoom({ matrixRoomId, mxid, expectedMessages }) {
  assert(matrixRoomId);
  assert(mxid);
  assert(expectedMessages);

  const messagesRes = await matrixUtils.getMessages({
    matrixRoomId,
    mxid,
    dir: 'b',
    limit: 100
  });

  const relevantMessageEvents = messagesRes.chunk.filter(event => {
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
    userRandom: {
      accessToken: 'web-internal'
    },
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

  before(async () => {
    await ensureMatrixFixtures();
  });

  let stopBridge;
  const gitterRoomToFixtureMessagesMap = new WeakMap();
  beforeEach(async () => {
    await assertNotBridgedBefore(fixture.troupe1.id);
    await assertNotBridgedBefore(fixture.troupePrivate1.id);
    await assertNotBridgedBefore(fixture.troupeOneToOne.id);
    debug('Asserted that these rooms have not been bridged before');

    gitterRoomToFixtureMessagesMap.set(
      fixture.troupe1,
      await setupMessagesInRoom(fixture.troupe1, fixture.user1)
    );
    gitterRoomToFixtureMessagesMap.set(
      fixture.troupePrivate1,
      await setupMessagesInRoom(fixture.troupePrivate1, fixture.user1)
    );
    gitterRoomToFixtureMessagesMap.set(
      fixture.troupeOneToOne,
      await setupMessagesInRoom(fixture.troupeOneToOne, fixture.user1)
    );
    debug('Setup messages in rooms');

    // It's important that this comes after we setup all of the messages in the room so
    // that we don't prematurely bridge all of the messages we sent via
    // `setupMessagesInRoom`. Our tests assume these messages have not been bridged
    // before.
    stopBridge = await installBridge(bridgePortFromConfig + 1);
  });

  afterEach(async () => {
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
    const userRandomMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      fixture.userRandom.id
    );
    await assertCanJoinMatrixRoom({
      matrixRoomId,
      matrixHistoricalRoomId,
      mxid: userRandomMxid,
      expectToJoin: true,
      descriptionSecurityType: 'public',
      descriptionPerspective: 'a random user'
    });

    // Assert the history
    await assertHistoryInMatrixRoom({
      matrixRoomId: matrixHistoricalRoomId,
      mxid: userRandomMxid,
      expectedMessages: [1, 2, 3, 4, 5, 6]
    });
  });

  it('historical room stops and continues seamlessly to the live room (no message duplication/overlap)', async () => {
    // Pretend that we already bridged messages 4-6
    const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(fixture.troupe1.id);
    const fixtureMessages = gitterRoomToFixtureMessagesMap.get(fixture.troupe1);
    await matrixStore.storeBridgedMessage(
      fixtureMessages[3],
      matrixRoomId,
      `$${fixtureLoader.generateGithubId()}`
    );
    await matrixStore.storeBridgedMessage(
      fixtureMessages[4],
      matrixRoomId,
      `$${fixtureLoader.generateGithubId()}`
    );
    await matrixStore.storeBridgedMessage(
      fixtureMessages[5],
      matrixRoomId,
      `$${fixtureLoader.generateGithubId()}`
    );

    // The function under test.
    //
    // We should only see messages 1-3 imported in the historical room since the live
    // room already had some history.
    await importHistoryFromRooms([fixture.troupe1]);

    const matrixHistoricalRoomId = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
      fixture.troupe1.id
    );

    // Try to join the room from some random Matrix user's perspective. We should be
    // able to get in to a public room!
    const userRandomMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
      fixture.userRandom.id
    );
    await assertCanJoinMatrixRoom({
      matrixRoomId,
      matrixHistoricalRoomId,
      mxid: userRandomMxid,
      expectToJoin: true,
      descriptionSecurityType: 'public',
      descriptionPerspective: 'a random user'
    });

    // Assert the history
    await assertHistoryInMatrixRoom({
      matrixRoomId: matrixHistoricalRoomId,
      mxid: userRandomMxid,
      // We should only see messages 1-3 imported in the historical room since the live
      // room already had some history (4-6).
      expectedMessages: [1, 2, 3]
    });
  });

  [
    {
      label: 'private Gitter room',
      gitterRoomFixtureKey: 'troupePrivate1'
    },
    {
      label: 'ONE_TO_ONE Gitter room',
      gitterRoomFixtureKey: 'troupeOneToOne'
    }
  ].forEach(testMeta => {
    assert(testMeta.label);
    assert(testMeta.gitterRoomFixtureKey);

    it(`imports history to Matrix for ${testMeta.label}`, async () => {
      const gitterRoom = fixture[testMeta.gitterRoomFixtureKey];
      assert(gitterRoom);

      // The function under test
      await importHistoryFromRooms([gitterRoom]);

      const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(gitterRoom.id);
      const matrixHistoricalRoomId = await matrixStore.getHistoricalMatrixRoomIdByGitterRoomId(
        gitterRoom.id
      );

      // Try to join the room from some Matrix user's perspective. We shouldn't be able to get in!
      const userRandomMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
        fixture.userRandom.id
      );
      await assertCanJoinMatrixRoom({
        matrixRoomId,
        matrixHistoricalRoomId,
        mxid: userRandomMxid,
        expectToJoin: false,
        descriptionSecurityType: 'private',
        descriptionPerspective: 'a random user'
      });

      // Try to join the room from the perspective of a user in the private Matrix room.
      // We *should* be able to get in!
      const user1Mxid = await matrixStore.getMatrixUserIdByGitterUserId(fixture.user1.id);
      await assertCanJoinMatrixRoom({
        matrixRoomId,
        matrixHistoricalRoomId,
        mxid: user1Mxid,
        expectToJoin: true,
        descriptionSecurityType: 'private',
        descriptionPerspective: 'a user in the private room'
      });

      // Assert the history
      await assertHistoryInMatrixRoom({
        matrixRoomId: matrixHistoricalRoomId,
        mxid: user1Mxid,
        expectedMessages: [1, 2, 3, 4, 5, 6]
      });
    });
  });
});
