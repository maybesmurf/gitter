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
const logger = env.logger;
const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);

const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const appEvents = require('gitter-web-appevents');
const chatService = require('gitter-web-chats');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const {
  gitterToMatrixHistoricalImport
} = require('gitter-web-matrix-bridge/lib/gitter-to-matrix-historical-import');
const ConcurrentQueue = require('../../scripts/utils/gitter-to-matrix-historical-import/concurrent-queue');

// Instead of side-effects where this can be included from other tests, just include it
// here always so we can better fight the flakey problems.
require('../../server/event-listeners').install();

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

const TEST_WAIT_TIMEOUT_MS = 5000;
async function setupMessagesInRoom(gitterRoom, user) {
  let seenMessageIdsOverAppEvents = [];
  const listenForAppEventsCallback = data => {
    if (data.type === 'chatMessage' && data.operation === 'create') {
      seenMessageIdsOverAppEvents.push(data.model.id || data.model._id);
    }
  };
  appEvents.onDataChange2(listenForAppEventsCallback);

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

  const gitterMessages = [message1, message2, message3, message4, message5, message6];
  const gitterMessageIds = gitterMessages.map(
    gitterMessage => gitterMessage.id || gitterMessage._id
  );

  debug(
    `setupMessagesInRoom: Created Gitter messages in room ${gitterRoom.id}\n`,
    gitterMessages.map((gitterMessage, index) => {
      return ` - ${index + 1}: ${gitterMessage.id || gitterMessage._id} - ${gitterMessage.text}`;
    })
  );

  // Try and wait for any appEvents to drain before moving on with the rest of the
  // tests.
  //
  // We don't want any of these chat message creation events to leak into the Matrix
  // bridge that we're about to install below.
  //
  // It's too hard to prevent side-effects from other tests having the appEvents and
  // event-listeners going so instead we just explicitly include it in this test and
  // wait for them to clear out.
  const waitForAppEventsPromise = new Promise((resolve, reject) => {
    logger.info(
      'setupMessagesInRoom: Waiting to see all gitterMessages over appEvents before moving on:',
      JSON.stringify(gitterMessageIds)
    );
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `setupMessagesInRoom: Timed out waiting to see all gitterMessages come over appEvents, expected=${gitterMessageIds} seenMessageIdsOverAppEvents=${seenMessageIdsOverAppEvents}`
        )
      );
    }, TEST_WAIT_TIMEOUT_MS);

    const checkIfSeenAllMessagesCallback = () => {
      const haveSeenAllGitterMessagesOverAppEvents = gitterMessages.every(gitterMessage => {
        const gitterMessageId = gitterMessage.id || gitterMessage._id;
        return seenMessageIdsOverAppEvents.some(seenMessageId => {
          return mongoUtils.objectIDsEqual(seenMessageId, gitterMessageId);
        });
      });

      if (haveSeenAllGitterMessagesOverAppEvents) {
        clearTimeout(timeoutId);
        appEvents.removeListener('dataChange2', checkIfSeenAllMessagesCallback);
        appEvents.removeListener('dataChange2', listenForAppEventsCallback);
        logger.info('setupMessagesInRoom: Saw all gitterMessages over appEvents ✅');
        resolve();
      }
    };
    appEvents.onDataChange2(checkIfSeenAllMessagesCallback);
  });

  await waitForAppEventsPromise;

  return gitterMessages;
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

  const relevantMessageEvents = messagesRes.chunk
    // Only grab message events
    .filter(event => {
      return event.type === 'm.room.message';
    })
    // An undefined body will mean that the event was redacted so we just want to
    // remove those from our comparison as they are deleted and not seen in the final
    // product.
    .filter(event => {
      return event.content.body !== undefined;
    })
    .reverse();

  // Assert the messages match the expected
  assert.deepEqual(
    relevantMessageEvents.map(event => {
      return event.content.body && event.content.body[0];
    }),
    expectedMessages
  );

  const messageAssertionMap = {
    1: event => {
      assert.strictEqual(event.content.body, '1 *one*');
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
      assert.strictEqual(event.content.body, '4 *four*');
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

  for (let i = 0; i < expectedMessages.length; i++) {
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

    // Make sure there are no weird side-effects or cross-talk between tests here
    await assertNotBridgedBefore(fixture.troupe1.id);
    await assertNotBridgedBefore(fixture.troupePrivate1.id);
    await assertNotBridgedBefore(fixture.troupeOneToOne.id);
    debug('Asserted that these rooms have not been bridged before');
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

  // If we see a `E11000 duplicate key error collection:
  // gitter.matricesbridgedchatmessage index: gitterMessageId_1 dup key: { :
  // ObjectId('...') }`, then we know that this is a room where we were initially
  // bridging to a `gitter.im` "live" room and that community asked us to bridge to
  // their own Matrix room (custom plumb).
  //
  // The reason this error occurs is because our `stopAtMessageId` point is
  // wrong because we are looking at the first bridged message to their custom Matrix
  // room instead of our initial `gitter.im` "live" room which we no longer track.
  //
  // This error means the historical room reached the point where the old `gitter.im`
  // "live" room so technically we're done importing anyway (the messages exist on
  // Matrix somewhere but they will have to manage that chain themselves).
  it(
    'historical room stops gracefully when we hit a message that has already been bridged ' +
      'in an old "live" Matrix room and then was custom plumbed to another Matrix room' +
      '(MongoError E11000 duplicate key error, collision)',
    async () => {
      const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(
        fixture.troupe1.id
      );
      const fixtureMessages = gitterRoomToFixtureMessagesMap.get(fixture.troupe1);

      // Pretend that we already bridged messages 4 in a old `gitter.im` Matrix room
      // before it was updated to a custom plumbed room
      await matrixStore.storeBridgedMessage(
        fixtureMessages[3],
        '!previous-live-room:gitter.im',
        `$${fixtureLoader.generateGithubId()}`
      );
      // Pretend that we already bridged messages 5-6 in a custom plumbed room
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
        // We should only see messages 1-3 imported in the historical room since the old "live"
        // room already message history (4) and the custom plumb has (5-6).
        expectedMessages: [1, 2, 3]
      });
    }
  );
});
