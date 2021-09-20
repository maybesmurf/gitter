#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const LRU = require('lru-cache');
const debug = require('debug')('gitter:scripts:backfill-existing-history-to-matrix');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');

const matrixUtils = new MatrixUtils(matrixBridge);

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const asToken = config.get('matrix:bridge:asToken');

const matrixBridgeUserMxid = matrixUtils.getMxidForMatrixBridgeUser();

const MSC2716_HISTORICAL_CONTENT_FIELD = 'org.matrix.msc2716.historical';

const BATCH_SIZE = 100;

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'Uri of the room to delete'
  })
  .help('help')
  .alias('help', 'h').argv;

const gitterUserIdToMatrixProfileCache = LRU({
  max: 2048,
  // 15 minutes
  maxAge: 15 * 60 * 1000
});
async function getMatrixProfileFromGitterUserId(gitterUserId) {
  const serializedGitterUserId = mongoUtils.serializeObjectId(gitterUserId);

  const cachedEntry = gitterUserIdToMatrixProfileCache.get(serializedGitterUserId);
  if (cachedEntry) {
    return cachedEntry;
  }

  const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

  const intent = matrixBridge.getIntent(gitterUserMxid);
  const currentProfile = await intent.getProfileInfo(gitterUserMxid, null);

  const profileEntry = {
    mxid: gitterUserMxid,
    displayname: currentProfile.displayname,
    avatar_url: currentProfile.avatar_url
  };

  gitterUserIdToMatrixProfileCache.set(serializedGitterUserId, profileEntry);

  return profileEntry;
}

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

async function processBatchOfEvents(matrixRoomId, eventEntries, stateEvents, prevEventId, chunkId) {
  assert(matrixRoomId);
  assert(eventEntries);
  assert(stateEvents);
  assert(prevEventId);

  debug(
    `Processing batch: ${eventEntries.length} events, ${stateEvents.length} stateEvents, prevEventId=${prevEventId}, chunkId=${chunkId}`
  );

  const res = await request({
    method: 'POST',
    uri: `${homeserverUrl}/_matrix/client/unstable/org.matrix.msc2716/rooms/${matrixRoomId}/batch_send?prev_event=${prevEventId}${
      chunkId ? `&chunk_id=${chunkId}` : ''
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

  logger.info('batch res', res.statusCode, res.body);
  if (res.statusCode !== 200) {
    throw new Error(`Batch send request failed ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }

  const nextChunkId = res.body.next_chunk_id;

  // Slice off the following meta events to just get the historical message:
  let historicalMessages;
  // - insertion event ID for chunk at the start
  // - chunk event ID (at the end)
  if (chunkId) {
    historicalMessages = res.body.events.slice(1, res.body.events.length - 1);
  }
  // - insertion event ID for chunk at the start
  // - chunk event ID (second to the end)
  // - base insertion event ID (at the end)
  else {
    historicalMessages = res.body.events.slice(1, res.body.events.length - 2);
  }

  // Record all of the newly bridged messages
  assert.strictEqual(historicalMessages.length, eventEntries.length);
  for (let i = 0; i < eventEntries.length; i++) {
    const matrixEventId = historicalMessages[i];
    const gitterMessage = eventEntries[i].gitterMessage;

    await matrixStore.storeBridgedMessage(gitterMessage, matrixRoomId, matrixEventId);
  }

  return nextChunkId;
}

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
    // chunk of messages we try to backfill, let's just be careful and not try
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
  let nextChunkId;

  // We're looking for some primordial event at the beginning of the room
  // to hang all of the historical messages off of. We can't use the create event
  // because it is before the application service joined the room.
  // So we just use the first join event for the application service.
  const bridgeJoinEvent = await getMatrixBridgeUserJoinEvent(matrixRoomId);
  debug(`Found bridgeJoinEvent`, bridgeJoinEvent);

  // Just a small wrapper around processing that can process and reset
  const _processBatch = async function() {
    // Put the events in chronological order for the batch.
    // They are originally looped in descending order to go from newest to oldest
    // which makes them reverse-chronological at first.
    const chronologicalEntries = eventEntries.reverse();
    nextChunkId = await processBatchOfEvents(
      matrixRoomId,
      chronologicalEntries,
      stateEvents,
      bridgeJoinEvent.event_id,
      nextChunkId
    );

    // Reset the batch now that it was processed
    eventEntries = [];
    stateEvents = [];
    authorMap = {};
  };

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

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  debug(
    `Found matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  // TODO: We can only backfill in rooms which we can control
  // because we know the @gitter-badger:gitter.im is the room creator
  // which is the only user who can backfill in existing room versions.

  await handleMainMessages(gitterRoom, matrixRoomId);
}

exec()
  .then(() => {
    logger.info('done');
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error('Error occurred while backfilling events:', err.stack);
    shutdown.shutdownGracefully();
  });
