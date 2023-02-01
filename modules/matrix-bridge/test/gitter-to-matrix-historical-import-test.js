'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const env = require('gitter-web-env');
const config = env.config;

const installBridge = require('gitter-web-matrix-bridge');
const store = require('../lib/store');
const { isGitterRoomIdDoneImporting } = require('../lib/gitter-to-matrix-historical-import');

const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);

describe('gitter-to-matrix-historical-import', () => {
  let stopBridge;
  beforeEach(async () => {
    stopBridge = await installBridge(bridgePortFromConfig + 1);
  });

  afterEach(async () => {
    if (stopBridge) {
      await stopBridge();
    }
  });

  describe('isGitterRoomIdDoneImporting', () => {
    const fixture = fixtureLoader.setupEach({
      user1: {},
      group1: {},
      troupe1: {
        group: 'group1'
      },
      message1: {
        user: 'user1',
        troupe: 'troupe1',
        text: 'my gitter message1'
      },
      message2: {
        user: 'user1',
        troupe: 'troupe1',
        text: 'my gitter message2'
      },
      message3: {
        user: 'user1',
        troupe: 'troupe1',
        text: 'my gitter message3'
      }
    });

    let matrixRoomId;
    let matrixHistoricalRoomId;
    beforeEach(() => {
      matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      matrixHistoricalRoomId = `!${fixtureLoader.generateGithubId()}-historical:localhost`;
    });

    async function mockGitterMessageAsBridgedInLiveMatrixRoom(gitterMessage) {
      const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
      await store.storeBridgedMessage(gitterMessage, matrixRoomId, matrixMessageEventId);
    }

    async function mockGitterMessageAsBridgedInHistoricalMatrixRoom(gitterMessage) {
      const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
      await store.storeBridgedMessage(gitterMessage, matrixHistoricalRoomId, matrixMessageEventId);
    }

    it('returns false when no messages imported in historical or "live" Matrix room', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // No messages bridged

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, false);
    });

    it('returns false when no messages imported in historical Matrix', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // Messages only bridged in "live" Matrix room
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message3);

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, false);
    });

    it('returns false when messages that still need to be imported between the historical and  "live" Matrix room', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // A single message imported in historical Matrix room
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message1);

      // That leaves `fixture.message2` in the middle that still needs to be imported

      // A single message bridged in "live" Matrix room
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message3);

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, false);
    });

    it('returns true when all messages in "live" Matrix room', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // All messages bridged in the "live" Matrix room
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message1);
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message2);
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message3);

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, true);
    });

    it('returns true when all messages in historical Matrix room', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // All messages bridged in the historical Matrix room
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message1);
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message2);
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message3);

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, true);
    });

    it('returns true when all messages either in historical or "live" Matrix room', async () => {
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
      await store.storeBridgedHistoricalRoom(fixture.troupe1.id, matrixHistoricalRoomId);

      // A portion of messages bridged in the historical Matrix room
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message1);
      mockGitterMessageAsBridgedInHistoricalMatrixRoom(fixture.message2);

      // The rest of the messages are bridged in the historical Matrix room
      mockGitterMessageAsBridgedInLiveMatrixRoom(fixture.message3);

      const isDoneImporting = await isGitterRoomIdDoneImporting(fixture.troupe1.id);
      assert.strictEqual(isDoneImporting, true);
    });
  });
});
