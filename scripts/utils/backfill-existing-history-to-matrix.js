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
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const asToken = config.get('matrix:bridge:asToken');

const matrixBridgeUserMxid = matrixUtils.getMxidForMatrixBridgeUser();

const BATCH_SIZE = 100;

// const mongoose = require('mongoose');
// mongoose.set('debug', true);

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'Uri of the room to delete'
  })
  // .option('start-chat-id', {
  //   required: true,
  //   description: 'Where to start backfilling from (going back in time)'
  // })
  // .option('start-timestamp', {
  //   alias: 't',
  //   required: true,
  //   description: 'Where to start backfilling from'
  // })
  // .option('end-timestamp', {
  //   alias: 't',
  //   required: true,
  //   description: 'Where to stop backfilling at'
  // })
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
    uri: `http://localhost:18008/_matrix/client/r0/rooms/${matrixRoomId}/messages?dir=b&limit=100&filter={ "types": ["m.room.member"], "senders": ["${matrixBridgeUserMxid}"] }`,
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

async function processBatchOfEvents(matrixRoomId, events, stateEvents) {
  assert(matrixRoomId);
  assert(events);
  assert(stateEvents);

  console.log('stateEvents', stateEvents);

  debug(`Processing batch: ${events.length} events, ${stateEvents.length} stateEvents`);

  // We're looking for some primordial event at the beginning of the room
  // to hang all of the historical messages off of. We can't use the create event
  // because it is before the application service joined the room.
  // So we just use the first join event for the application service.
  const bridgeJoinEvent = await getMatrixBridgeUserJoinEvent(matrixRoomId);
  debug(`Found bridgeJoinEvent`, bridgeJoinEvent);

  const res = await request({
    method: 'POST',
    uri: `http://localhost:18008/_matrix/client/unstable/org.matrix.msc2716/rooms/${matrixRoomId}/batch_send?prev_event=${bridgeJoinEvent.event_id}`,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: {
      events: events,
      state_events_at_start: stateEvents
    }
  });

  console.log('batch res', res.statusCode, res.body);
  if (res.statusCode !== 200) {
    throw new Error(`Batch send request failed ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }

  // TODO: Record all of the newly bridged messages
}

// eslint-disable-next-line max-statements
async function exec() {
  console.log('Setting up Matrix bridge');
  await installBridge();

  const room = await troupeService.findByUri(opts.uri);
  const roomId = room.id || room._id;

  // TODO: Create bridged Matrix room when it hasn't been bridged before
  const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(roomId);
  debug(`Found matrixRoomId=${matrixRoomId} for given Gitter room ${room.uri} (${roomId})`);

  // TODO: We can only backfill in rooms which we can control
  // because we know the @gitter-badger:gitter.im is the room creator
  // which is the only user who can backfill in existing room versions.

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

  // Start the stream of messages where we left off
  const messageCursor = persistence.ChatMessage.find({
    _id: { $lt: firstBridgedMessageIdInRoom.gitterMessageId },
    toTroupeId: roomId,
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

  let events = [];
  let stateEvents = [];
  let authorMap = {};

  // Just a small wrapper around processing that can process and reset
  const _processBatch = async function() {
    //console.log('_processBatch==================================');
    // Put the events in chronological order for the batch.
    // They are originally looped in ascending order to go from newest to oldest
    // which makes them reverse-chronological at first.
    const chronologicalEvents = events.reverse();
    //console.log('chronologicalEvents', chronologicalEvents);
    await processBatchOfEvents(matrixRoomId, chronologicalEvents, stateEvents);

    // Reset the batch now that it was processed
    events = [];
    stateEvents = [];
    authorMap = {};
  };

  for await (let message of chatMessageStreamIterable) {
    //console.log('message', message.text);
    const { mxid, avatar_url, displayname } = await getMatrixProfileFromGitterUserId(
      message.fromUserId
    );

    // Message event
    events.push({
      type: 'm.room.message',
      sender: mxid,
      origin_server_ts: new Date(message.sent).getTime(),
      content: {
        msgtype: 'm.text',
        body: message.text,
        MSC2716_HISTORICAL: true
      }
    });

    // deduplicate the authors
    if (!authorMap[message.fromUserId]) {
      // Invite event
      stateEvents.push({
        type: 'm.room.member',
        sender: matrixBridgeUserMxid,
        origin_server_ts: events[0].origin_server_ts,
        content: {
          membership: 'invite'
        },
        state_key: mxid
      });

      // Join event
      stateEvents.push({
        type: 'm.room.member',
        sender: mxid,
        origin_server_ts: events[0].origin_server_ts,
        content: {
          avatar_url: avatar_url,
          displayname: displayname,
          membership: 'join'
        },
        state_key: mxid
      });

      // Mark this author off
      authorMap[message.fromUserId] = true;
    }

    if (events.length >= BATCH_SIZE) {
      await _processBatch();
    }
  }

  // Process the remainder last batch
  await _processBatch();
}

exec()
  .then(() => {
    console.log('done');
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    console.error('Error occured while backfilling events:', err.stack);
    shutdown.shutdownGracefully();
  });
