#!/usr/bin/env node
'use strict';

const env = require('gitter-web-env');
const config = env.config;
const shutdown = require('shutdown');
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const chatService = require('gitter-web-chats');
const userService = require('gitter-web-users');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const getMxidForGitterUser = require('gitter-web-matrix-bridge/lib/get-mxid-for-gitter-user');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const asToken = config.get('matrix:bridge:asToken');

// TODO: Just fetch this automatically
const prevEvent = '$7oAxqXDcAG0fVtXOwGIgoGaDtPSK7lkHeR1Ov4lzit4';

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'Uri of the room to delete'
  })
  .option('start-chat-id', {
    required: true,
    description: 'Where to start backfilling from (going back in time)'
  })
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
    uri: `http://localhost:8008/_matrix/client/r0/register`,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'm.login.application_service', username: virtualUserLocalpart })
  });

  //console.log('register res', res.statusCode, res.body, typeof res.body);
  const body = JSON.parse(res.body);

  if (res.statusCode === 200) {
    return;
  } else if (res.statusCode === 400 && body && body.errcode === 'M_USER_IN_USE') {
    return;
  } else {
    throw new Error(
      `Registering virtualUserLocalpart=${virtualUserLocalpart} failed ${res.statusCode}: ${res.body}`
    );
  }
}

async function exec() {
  // console.log('Setting up Matrix bridge');
  // await installBridge();

  const room = await troupeService.findByUri(opts.uri);

  const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(room._id);

  const toTimestamp = mongoUtils.getTimestampFromObjectId(opts.startChatId);
  const messages = await chatService.findChatMessagesForTroupeForDateRange(
    room._id,
    0,
    toTimestamp
  );
  console.log(`Found ${messages.length} messages from the beginning of the room to ${toTimestamp}`);

  const stateEvents = [];
  const events = [];

  const authorMap = {};
  for await (let message of messages) {
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
  }

  for await (let gitterUser of Object.values(authorMap)) {
    const matrixId = getMxidForGitterUser(gitterUser);

    stateEvents.push({
      type: 'm.room.member',
      sender: matrixId,
      origin_server_ts: new Date(messages[0].sent).getTime(),
      content: {
        membership: 'join'
      },
      state_key: matrixId
    });
  }

  console.log('state events', stateEvents);
  console.log('events', events);

  // TODO: the user_id should not be needed for this endpoint and membership should work
  const TODO_REMOVE_USER_ID_FOR_REQUEST = stateEvents[0].sender;

  const res = await request({
    method: 'POST',
    uri: `http://localhost:8008/_matrix/client/unstable/org.matrix.msc2716/rooms/${matrixRoomId}/batch_send?prev_event=${prevEvent}&user_id=${TODO_REMOVE_USER_ID_FOR_REQUEST}`,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      events: events,
      state_events_at_start: stateEvents
    })
  });

  console.log('batch res', res.statusCode, res.body);
  if (res.statusCode !== 200) {
    throw new Error(`Batch send request failed ${res.statusCode}: ${res.body}`);
  }
}

exec()
  .then(() => {
    console.log('done');
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    console.error(err);
    console.error(err.stack);
    shutdown.shutdownGracefully();
  });
