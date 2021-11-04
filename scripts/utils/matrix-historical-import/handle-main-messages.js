'use strict';

const assert = require('assert');
const { performance } = require('perf_hooks');
const debug = require('debug')('gitter:scripts:matrix-historical-import:handle-main-messages');
const env = require('gitter-web-env');
const config = env.config;
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const processBatchOfEvents = require('./process-batch-of-events');
const getMatrixProfileFromGitterUserId = require('./get-matrix-profile-from-gitter-user-id');
const { MSC2716_HISTORICAL_CONTENT_FIELD } = require('./constants');
assert(MSC2716_HISTORICAL_CONTENT_FIELD);

const matrixUtils = new MatrixUtils(matrixBridge);

const matrixBridgeUserMxid = matrixUtils.getMxidForMatrixBridgeUser();

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const asToken = config.get('matrix:bridge:asToken');

const BATCH_SIZE = 100;

async function getMatrixBridgeUserJoinEvent(matrixRoomId) {
  const res = await request({
    method: 'GET',
    uri: `${homeserverUrl}/_matrix/client/r0/rooms/${matrixRoomId}/messages?dir=b&limit=100&filter={ "types": ["m.room.member"], "senders": ["${matrixBridgeUserMxid}"] }`,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (res.statusCode !== 200) {
    throw new Error(
      `${matrixRoomId}/messages request to get the join event for the Matrix bridge user failed ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  if (!res.body.chunk || !res.body.chunk.length) {
    throw new Error(
      `Unable to find member event for the Matrix bridge user in ${matrixRoomId}/messages response ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  const joinEvents = res.body.chunk.filter(memberEvent => {
    return (
      memberEvent.content.membership === 'join' &&
      // We want the first join event (there won't be any previous content to replace)
      !memberEvent.prev_content
    );
  });

  if (joinEvents.length !== 1) {
    throw new Error(
      `Found ${
        joinEvents.length
      } join events (with no prev_content) but we expected to only find 1 primordial join event for the Matrix bridge user in ${matrixRoomId}/messages response ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  return joinEvents[0];
}

// eslint-disable-next-line max-statements
async function handleMainMessages(gitterRoom, matrixRoomId) {
  assert(gitterRoom);
  assert(matrixRoomId);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  // Find the earliest-in-time message that we have already bridged,
  // ie. where we need to start backfilling from
  const firstBridgedMessageInRoomResult = await persistence.MatrixBridgedChatMessage.where(
    'matrixRoomId',
    matrixRoomId
  )
    .limit(1)
    .select({ _id: 0, gitterMessageId: 1 })
    .sort({ gitterMessageId: 'asc' })
    .lean()
    .exec();
  const firstBridgedMessageIdInRoom = firstBridgedMessageInRoomResult[0];

  // TODO: Add fallback when we haven't bridged any messages in the room before
  assert(firstBridgedMessageIdInRoom);

  debug(`firstBridgedMessageInRoom=${JSON.stringify(firstBridgedMessageIdInRoom)}`);

  const messageCursor = persistence.ChatMessage.find({
    // Start the stream of messages where we left off
    _id: { $lt: firstBridgedMessageIdInRoom.gitterMessageId },
    toTroupeId: gitterRoomId,
    // Although we probably won't find any Matrix bridged messages in the old
    // batch of messages we try to backfill, let's just be careful and not try
    // to re-bridge any previously bridged Matrix messages by accident.
    virtualUser: { $exists: false }
  })
    .sort({ _id: 'desc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(BATCH_SIZE)
    .cursor();

  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  let eventEntries = [];
  let stateEvents = [];
  let authorMap = {};
  // TODO: We need to persist this somewhere so that if the import crashes for
  // some reason, we can resume
  let nextBatchId;

  // We're looking for some primordial event at the beginning of the room
  // to hang all of the historical messages off of. We can't use the create event
  // because it is before the application service joined the room.
  // So we just use the first join event for the application service.
  const bridgeJoinEvent = await getMatrixBridgeUserJoinEvent(matrixRoomId);
  debug(`Found bridgeJoinEvent`, bridgeJoinEvent);

  // Just a small wrapper around processing that can process and reset
  let batchCount = 0;
  const _processBatch = async function() {
    performance.mark(`batchAssembleEnd${batchCount}`);

    performance.measure(
      'measure batch assembly',
      `batchAssembleStart${batchCount}`,
      `batchAssembleEnd${batchCount}`
    );

    // Put the events in chronological order for the batch.
    // They are originally looped in descending order to go from newest to oldest
    // which makes them reverse-chronological at first.
    const chronologicalEntries = eventEntries.reverse();
    nextBatchId = await processBatchOfEvents(
      matrixRoomId,
      chronologicalEntries,
      stateEvents,
      bridgeJoinEvent.event_id,
      nextBatchId
    );

    // Reset the batch now that it was processed
    eventEntries = [];
    stateEvents = [];
    authorMap = {};
    // Increment the batch count
    batchCount += 1;

    performance.mark(`batchAssembleStart${batchCount}`);
  };

  performance.mark(`batchAssembleStart${batchCount}`);
  for await (let message of chatMessageStreamIterable) {
    const { mxid, avatar_url, displayname } = await getMatrixProfileFromGitterUserId(
      message.fromUserId
    );

    const matrixContent = generateMatrixContentFromGitterMessage(message);
    matrixContent[MSC2716_HISTORICAL_CONTENT_FIELD] = true;

    // Message event
    eventEntries.push({
      gitterMessage: message,
      matrixEvent: {
        type: 'm.room.message',
        sender: mxid,
        origin_server_ts: new Date(message.sent).getTime(),
        content: matrixContent
      }
    });

    // deduplicate the authors
    if (!authorMap[message.fromUserId]) {
      // This join to the current room state is what causes Element to actually
      // pick up avatars/displaynames. The floating outlier join event below
      // does not get picked up.
      // const intent = matrixBridge.getIntent(mxid);
      // await intent.join(matrixRoomId);

      // Invite event
      stateEvents.push({
        type: 'm.room.member',
        sender: matrixBridgeUserMxid,
        origin_server_ts: eventEntries[0].matrixEvent.origin_server_ts,
        content: {
          membership: 'invite'
        },
        state_key: mxid
      });

      // Join event
      stateEvents.push({
        type: 'm.room.member',
        sender: mxid,
        origin_server_ts: eventEntries[0].matrixEvent.origin_server_ts,
        content: {
          membership: 'join',
          // These aren't picked up by Element but still seems good practice to
          // have them in place for other clients/homeservers
          avatar_url: avatar_url,
          displayname: displayname
        },
        state_key: mxid
      });

      // Mark this author off
      authorMap[message.fromUserId] = true;
    }

    if (eventEntries.length >= BATCH_SIZE) {
      await _processBatch();
    }
  }

  // Process the remainder last batch
  await _processBatch();
}

module.exports = handleMainMessages;
