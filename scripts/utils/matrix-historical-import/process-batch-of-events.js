'use strict';

const assert = require('assert');
const { performance } = require('perf_hooks');
const debug = require('debug')('gitter:scripts:matrix-historical-import:process-batch-of-events');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const asToken = config.get('matrix:bridge:asToken');

const matrixUtils = new MatrixUtils(matrixBridge);

async function processBatchOfEvents(matrixRoomId, eventEntries, stateEvents, prevEventId, batchId) {
  assert(matrixRoomId);
  assert(eventEntries);
  assert(stateEvents);
  assert(prevEventId);

  debug(
    `Processing batch: ${eventEntries.length} events, ${stateEvents.length} stateEvents, prevEventId=${prevEventId}, batchId=${batchId}`
  );

  performance.mark('batchSendStart');
  const res = await request({
    method: 'POST',
    uri: `${homeserverUrl}/_matrix/client/unstable/org.matrix.msc2716/rooms/${matrixRoomId}/batch_send?prev_event_id=${prevEventId}${
      batchId ? `&batch_id=${batchId}` : ''
    }`,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: {
      events: eventEntries.map(tuple => tuple.matrixEvent),
      state_events_at_start: stateEvents
    }
  });
  performance.mark('batchSendEnd');

  performance.measure(
    'matrix-bridge.import.batch_send_request.time',
    'batchSendStart',
    'batchSendEnd'
  );

  performance.clearMarks(`batchSendStart`);
  performance.clearMarks(`batchSendEnd`);

  //logger.info(`batch res`, res.statusCode, res.body);
  if (res.statusCode !== 200) {
    throw new Error(`Batch send request failed ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }

  const nextBatchId = res.body.next_batch_id;
  const historicalMessages = res.body.event_ids;
  const baseInsertionEventId = res.body.base_insertion_event_id;

  // Record all of the newly bridged messages
  assert.strictEqual(historicalMessages.length, eventEntries.length);
  for (let i = 0; i < eventEntries.length; i++) {
    const matrixEventId = historicalMessages[i];
    const gitterMessage = eventEntries[i].gitterMessage;

    // TODO: Make sure we try hard to only allow the script to shutdown gracefully after
    // we have saved the result of the request. Otherwise, we will end up with
    // duplicates where we sent off the batch, canceled script before saving, and resume
    // later where we last saved.
    await matrixStore.storeBridgedMessage(gitterMessage, matrixRoomId, matrixEventId);
  }

  // Put marker in room so the history is discoverable by other federating homservers
  // with MSC2716 enabled
  if (baseInsertionEventId) {
    await matrixUtils.ensureStateEvent(matrixRoomId, 'org.matrix.msc2716.marker', {
      insertion_event_reference: baseInsertionEventId
    });
  }

  return nextBatchId;
}

module.exports = processBatchOfEvents;
