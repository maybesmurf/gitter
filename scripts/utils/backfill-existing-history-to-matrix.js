#!/usr/bin/env node
'use strict';

const assert = require('assert');
const shutdown = require('shutdown');
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const debug = require('debug')('gitter:scripts:backfill-existing-history-to-matrix');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const userService = require('gitter-web-users');
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const getMxidForGitterUser = require('gitter-web-matrix-bridge/lib/get-mxid-for-gitter-user');
//const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const asToken = config.get('matrix:bridge:asToken');

const matrixBridgeUserMxid = matrixUtils.getMxidForMatrixBridgeUser();

const BATCH_SIZE = 100;

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

// ensureVirtualUserRegistered makes sure the user is registered for the homeserver regardless
// if they are already registered or not. If unable to register, throws an error
async function ensureVirtualUserRegistered(virtualUserLocalpart) {
  const res = await request({
    method: 'POST',
    uri: `http://localhost:18008/_matrix/client/r0/register`,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: { type: 'm.login.application_service', username: virtualUserLocalpart }
  });

  // User was registered successfully
  if (res.statusCode === 200) {
    return;
  }
  // User is already registered. No more action needed.
  else if (res.statusCode === 400 && res.body && res.body.errcode === 'M_USER_IN_USE') {
    return;
  }
  // Otherwise, we had a problem registering the user
  else {
    throw new Error(
      `Registering virtualUserLocalpart=${virtualUserLocalpart} failed ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }
}

async function getMatrixCreateRoomEvent(matrixRoomId) {
  const res = await request({
    method: 'GET',
    uri: `http://localhost:18008/_matrix/client/r0/rooms/${matrixRoomId}/messages?dir=b&limit=1&filter={ "types": ["m.room.create"] }`,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (res.statusCode !== 200) {
    throw new Error(
      `${matrixRoomId}/messages request to get the create room event failed ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  if (!res.body.chunk || !res.body.chunk.length) {
    throw new Error(
      `Unable to find create room event in ${matrixRoomId}/messages response ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  return res.body.chunk[0];
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
    return memberEvent.content.membership === 'join';
  });

  if (joinEvents.length !== 1) {
    throw new Error(
      `Found ${
        joinEvents.length
      } join events but we expected to only find 1 join event for the Matrix bridge user in ${matrixRoomId}/messages response ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  return joinEvents[0];
}

async function processBatchOfEvents(matrixRoomId, events, authorMap) {
  assert(matrixRoomId);
  assert(events);
  assert(authorMap);

  debug(`Processing batch: ${events.length} events`);

  const stateEvents = [];
  for await (let gitterUser of Object.values(authorMap)) {
    const matrixId = getMxidForGitterUser(gitterUser);

    stateEvents.push({
      type: 'm.room.member',
      sender: matrixBridgeUserMxid,
      origin_server_ts: events[0].origin_server_ts,
      content: {
        membership: 'invite'
      },
      state_key: matrixId
    });

    stateEvents.push({
      type: 'm.room.member',
      sender: matrixId,
      origin_server_ts: events[0].origin_server_ts,
      content: {
        membership: 'join'
      },
      state_key: matrixId
    });
  }

  debug(`Processing batch: ${stateEvents.length} stateEvents`);
  console.log('stateEvents', stateEvents);

  //const createRoomEvent = await getMatrixCreateRoomEvent(matrixRoomId);
  //debug(`Found createRoomEvent`, createRoomEvent);
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

async function exec() {
  // console.log('Setting up Matrix bridge');
  // await installBridge();

  const room = await troupeService.findByUri(opts.uri);
  const roomId = room.id || room._id;

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
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(100)
    .cursor();
  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  let events = [];
  let authorMap = {};
  for await (let message of chatMessageStreamIterable) {
    // deduplicate the authors
    if (!authorMap[message.fromUserId]) {
      authorMap[message.fromUserId] = await userService.findById(message.fromUserId);
    }
    const mxid = getMxidForGitterUser(authorMap[message.fromUserId]);

    const virtualUserLocalpart = mxid.match(/@(.*?):.*/)[1];
    await ensureVirtualUserRegistered(virtualUserLocalpart);

    // const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(
    //   message.fromUserId
    // );

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

    if (events.length >= BATCH_SIZE) {
      await processBatchOfEvents(matrixRoomId, events, authorMap);

      // Reset the batch now that it was processed
      events = [];
      authorMap = {};
    }
  }

  // Process the remainder last batch
  await processBatchOfEvents(matrixRoomId, events, authorMap);
  // Reset the batch now that it was processed
  events = [];
  authorMap = {};
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
