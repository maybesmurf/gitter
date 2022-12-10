#!/usr/bin/env node
'use strict';

// Why aren't we using MSC2716?
//
// - MSC2716 isn't fully polished. It works but it still a bit crunchy for federated
//   homeservers to backfill all of the history in order and we just punted this problem
//   to when Synapse supports online topological ordering which is beeeg future task.
// - Trying the MSC2716 version of this script out now (see
//   `scripts/utils/msc2716-backfill-existing-history-to-matrix.js`), the threads don't
//   automatically show up in Element. I'm not sure why Element isn't using the bundled
//   aggregations to show the thread preview. The threads do appear in the timeline once
//   you open the thread list view. This seems like it could be fixed but it's yet
//   another thing to do.
// - Also since Hydrogen doesn't support threads yet, the threads won't be visible in
//   the Matrix Public Archive or if they are, it will just be a big chunk where all the
//   thread reply fallbacks will be. It will be better if we can import messages one by
//   one and mix the thread replies right under the thread parent for easy viewing in
//   clients where threads aren't supported.

const assert = require('assert');
const { PerformanceObserver } = require('perf_hooks');
const shutdown = require('shutdown');
const LRU = require('lru-cache');
const Promise = require('bluebird');
const request = Promise.promisify(require('request'));
const StatusError = require('statuserror');
const debug = require('debug')('gitter:scripts:matrix-historical-import');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const config = env.config;
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const asToken = config.get('matrix:bridge:asToken');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE = 500;

const gitterUserIdToMxidCache = LRU({
  max: 500,
  // 15 minutes
  maxAge: 15 * 60 * 1000
});

async function _getOrCreateMatrixUserByGitterUserIdCached(gitterUserId) {
  const cachedEntry = gitterUserIdToMxidCache.get(gitterUserId);
  if (cachedEntry) {
    return cachedEntry;
  }

  const matrixId = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

  gitterUserIdToMxidCache.set(gitterUserId, matrixId);

  return matrixId;
}

// Will log out any `performance.measure(...)` calls in subsequent code
const observer = new PerformanceObserver(list =>
  list.getEntries().forEach(entry => {
    if (entry.startTime === 0) {
      logger.warn(
        'Performance measurement entry had `startTime` of `0` which seems a bit fishy. ' +
          " Your measurement probably didn't start exactly when the app started up at time `0` so" +
          'this is probably more indicative a typo in the start/end marker string'
      );
    }

    if (entry.duration === 0) {
      logger.warn(
        'Performance measurement entry had `duration` of `0` which seems a bit fishy. ' +
          " Your measurement probably didn't last `0` seconds so" +
          'this is probably more indicative a typo in the start/end marker string'
      );
    }

    debug(`${entry.name} took ${entry.duration / 1000}s`);

    stats.responseTime(entry.name, entry.duration);
  })
);
observer.observe({ buffered: true, entryTypes: ['measure'] });

const opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'URI of the Gitter room to backfill'
  })
  .help('help')
  .alias('help', 'h').argv;

// Find the earliest-in-time message that we have already bridged,
// ie. where we need to start backfilling from to resume (resumability)
async function findEarliestBridgedMessageInRoom(matrixRoomId) {
  const firstBridgedMessageEntryInRoomResult = await persistence.MatrixBridgedChatMessage.where(
    'matrixRoomId',
    matrixRoomId
  )
    .limit(1)
    .select({ _id: 0, gitterMessageId: 1 })
    .sort({ gitterMessageId: 'asc' })
    .lean()
    .exec();
  const firstBridgedMessageEntryInRoom = firstBridgedMessageEntryInRoomResult[0];
  if (firstBridgedMessageEntryInRoom) {
    debug(
      `Resuming from firstBridgedMessageInRoom=${JSON.stringify(
        firstBridgedMessageEntryInRoom
      )} (matrixRoomId=${matrixRoomId})`
    );
  }

  return firstBridgedMessageEntryInRoom;
}

let txnCount = 0;
function getTxnId() {
  txnCount++;
  return `${new Date().getTime()}--${txnCount}`;
}

async function sendEventAtTimestmapRaw({ type, matrixRoomId, mxid, matrixContent, timestamp }) {
  assert(type);
  assert(matrixRoomId);
  assert(mxid);
  assert(matrixContent);
  assert(timestamp);

  const sendEndpoint = `${homeserverUrl}/_matrix/client/v3/rooms/${matrixRoomId}/send/${type}/${getTxnId()}?user_id=${mxid}&ts=${timestamp}`;
  const res = await request({
    method: 'POST',
    uri: sendEndpoint,
    json: true,
    headers: {
      Authorization: `Bearer ${asToken}`,
      'Content-Type': 'application/json'
    },
    body: matrixContent
  });

  if (res.statusCode !== 200) {
    throw new StatusError(
      res.statusCode,
      `sendEventAtTimestmap({ matrixRoomId: ${matrixRoomId} }) failed ${
        res.statusCode
      }: ${JSON.stringify(res.body)}`
    );
  }

  const eventId = res.body.event_id;
  assert(
    eventId,
    `The request made in sendEventAtTimestmap (${sendEndpoint}) did not return \`event_id\` as expected. ` +
      `This is probably a problem with that homeserver.`
  );

  return eventId;
}

// Will send message and join the room if necessary
async function sendEventAtTimestmap({ type, matrixRoomId, mxid, matrixContent, timestamp }) {
  const _sendEventWrapper = async () => {
    const eventId = await sendEventAtTimestmapRaw({
      type,
      matrixRoomId,
      mxid,
      matrixContent,
      timestamp
    });

    return eventId;
  };

  let eventId;
  try {
    // Try the happy-path first and assume we're joined to the room
    eventId = await _sendEventWrapper();
  } catch (err) {
    // If we get a 403 forbidden indicating we're not in the room yet, let's try to join
    if (err.status === 403) {
      const intent = matrixBridge.getIntent(mxid);
      await intent._ensureJoined(matrixRoomId);
    } else {
      // We don't know how to recover from an arbitrary error that isn't about joining
      throw err;
    }

    // Now that we're joined, try again
    eventId = await _sendEventWrapper();
  }

  return eventId;
}

async function importFromChatMessageStreamIterable({
  gitterRoomId,
  matrixRoomId,
  matrixHistoricalRoomId,
  chatMessageStreamIterable
}) {
  for await (let message of chatMessageStreamIterable) {
    const matrixId = await _getOrCreateMatrixUserByGitterUserIdCached(message.fromUserId);
    const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, message);

    // Will send message and join the room if necessary
    const eventId = await sendEventAtTimestmap({
      type: 'm.room.message',
      matrixRoomId,
      mxid: matrixId,
      matrixContent,
      timestamp: new Date(message.sent).getTime()
    });
    await matrixStore.storeBridgedMessage(message, matrixHistoricalRoomId, eventId);

    if (message.threadMessageCount) {
      // TODO: Handle sending threaded replies for every thread parent
      const threadReplyMessageCursor = persistence.ChatMessage.find({
        //  TODO: Can we resume this?
        toTroupeId: gitterRoomId,
        // No threaded messages in our main iterable.
        parentId: message.id,
        // Although we probably won't find any Matrix bridged messages in the old
        // batch of messages we try to backfill, let's just be careful and not try
        // to re-bridge any previously bridged Matrix messages by accident.
        virtualUser: { $exists: false }
      })
        // Go from oldest to most recent so everything appears in the order it was sent in
        // the first place
        .sort({ _id: 'ASC' })
        .lean()
        .read(mongoReadPrefs.secondaryPreferred)
        .batchSize(DB_BATCH_SIZE)
        .cursor();
    }
  }
}

async function importMessagesFromGitterRoomToHistoricalMatrixRoom({
  gitterRoom,
  matrixRoomId,
  matrixHistoricalRoomId
}) {
  assert(gitterRoom);
  assert(matrixRoomId);
  assert(matrixHistoricalRoomId);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;
  debug(
    `Starting import of main messages for ${gitterRoom.uri} (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (this live room is matrixRoomId=${matrixRoomId})`
  );

  // Where to resume from
  const firstBridgedMessageEntryIdInHistoricalRoom = await findEarliestBridgedMessageInRoom(
    matrixHistoricalRoomId
  );
  // Where we should stop importing at because the live room will pick up from this point
  const firstBridgedMessageEntryIdInLiveRoom = await findEarliestBridgedMessageInRoom(matrixRoomId);

  const messageCursor = persistence.ChatMessage.find({
    // Start the stream of messages where we left off, earliest message, going forwards
    _id: (() => {
      let idQuery = {};
      // Where to resume from
      if (firstBridgedMessageEntryIdInHistoricalRoom) {
        idQuery['$gt'] = firstBridgedMessageEntryIdInHistoricalRoom.gitterMessageId;
      }
      // Where we should stop importing at because the live room will pick up from this point
      if (firstBridgedMessageEntryIdInLiveRoom) {
        idQuery['$lt'] = firstBridgedMessageEntryIdInLiveRoom.gitterMessageId;
      }

      // If we haven't imported any history yet, just fallback to an `exists` (get all messages)
      if (!firstBridgedMessageEntryIdInHistoricalRoom && !firstBridgedMessageEntryIdInLiveRoom) {
        idQuery['$exists'] = true;
      }

      return idQuery;
    })(),
    toTroupeId: gitterRoomId,
    // No threaded messages in our main iterable.
    parentId: { $exists: false },
    // Although we probably won't find any Matrix bridged messages in the old
    // batch of messages we try to backfill, let's just be careful and not try
    // to re-bridge any previously bridged Matrix messages by accident.
    virtualUser: { $exists: false }
  })
    // Go from oldest to most recent so everything appears in the order it was sent in
    // the first place
    .sort({ _id: 'ASC' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE)
    .cursor();

  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable
  });
}

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  // Find our current live Matrix room
  let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );
  debug(
    `Found matrixRoomId=${matrixRoomId} matrixHistoricalRoomId=${matrixHistoricalRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  await importMessagesFromGitterRoomToHistoricalMatrixRoom({
    gitterRoom,
    matrixRoomId,
    matrixHistoricalRoomId
  });

  // Ensure tombstone event pointing to the main live room
  await matrixUtils.ensureStateEvent(matrixHistoricalRoomId, 'm.room.tombstone', {
    replacement_room: matrixRoomId
  });

  logger.info(
    `Successfully imported all historical messages for ${opts.uri} to matrixHistoricalRoomId=${matrixHistoricalRoomId}`
  );
}

exec()
  .then(() => {
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error(`Error occurred while backfilling events for ${opts.uri}:`, err.stack);
    shutdown.shutdownGracefully();
  });
