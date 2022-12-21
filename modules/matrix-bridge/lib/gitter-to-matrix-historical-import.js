'use strict';

const assert = require('assert');
const LRU = require('lru-cache');
const { performance } = require('perf_hooks');
const { EventEmitter } = require('events');
const shutdown = require('shutdown');
const debug = require('debug')('gitter:app:matrix-bridge:gitter-to-matrix-historical-import');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const chatService = require('gitter-web-chats');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');

// The number of chat messages we pull out at once to reduce database roundtrips
const DB_BATCH_SIZE_FOR_MESSAGES = 256;
const METRIC_SAMPLE_RATIO = 1 / 15;

const QUARTER_SECOND_IN_MS = 250;

const matrixUtils = new MatrixUtils(matrixBridge);

const matrixHistoricalImportEventEmitter = new EventEmitter();

let roomIdTofinalPromiseToAwaitBeforeShutdownMap = new Map();
shutdown.addHandler('matrix-bridge-batch-import', 20, async callback => {
  // This is to try to best avoid us resuming and duplicating the last message we were
  // sending in each room. Say we sent off the request, canceled the script before we
  // `storeBridgedMessage`, then we would resume and try to send that message again.
  logger.warn(
    'Waiting for this ongoing message send request to finish and bridged information stored...'
  );
  try {
    await Promise.all(roomIdTofinalPromiseToAwaitBeforeShutdownMap.values());
  } catch (err) {
    // We don't care about the error, we only care that the promise finished.
  }
  callback();
});

function sampledPerformance(frequency) {
  if (Math.random() < frequency) {
    return {
      performanceMark: performance.mark.bind(performance),
      performanceClearMarks: performance.clearMarks.bind(performance),
      performanceMeasure: performance.measure.bind(performance)
    };
  }

  return {
    performanceMark: () => {},
    performanceClearMarks: () => {},
    performanceMeasure: () => {}
  };
}

// Find the earliest-in-time message that we have already bridged,
// ie. where we need to stop backfilling from to resume (resumability)
async function findEarliestBridgedMessageInRoom(matrixRoomId) {
  const firstBridgedMessageEntryInRoomResult = await persistence.MatrixBridgedChatMessage.where(
    'matrixRoomId',
    matrixRoomId
  )
    .limit(1)
    // From oldest to most recent
    .sort({ gitterMessageId: 'asc' })
    .lean()
    .exec();
  const firstBridgedMessageEntryInRoom = firstBridgedMessageEntryInRoomResult[0];

  return firstBridgedMessageEntryInRoom;
}

// Find the latest-in-time message that we have already bridged,
// ie. where we need to start backfilling from to resume (resumability)
async function findLatestBridgedMessageInRoom(matrixRoomId) {
  const lastBridgedMessageEntryInRoomResult = await persistence.MatrixBridgedChatMessage.where(
    'matrixRoomId',
    matrixRoomId
  )
    .limit(1)
    // From most recent to oldest
    .sort({ gitterMessageId: 'desc' })
    .lean()
    .exec();
  const lastBridgedMessageEntryInRoom = lastBridgedMessageEntryInRoomResult[0];

  return lastBridgedMessageEntryInRoom;
}

const gitterUserIdToMxidCache = LRU({
  max: 500,
  // 15 minutes
  maxAge: 15 * 60 * 1000
});
async function _getOrCreateMatrixUserByGitterUserIdCached(gitterUserId) {
  const cacheKey = String(gitterUserId);
  const cachedEntry = gitterUserIdToMxidCache.get(cacheKey);
  if (cachedEntry) {
    return cachedEntry;
  }

  const matrixId = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

  gitterUserIdToMxidCache.set(cacheKey, matrixId);

  return matrixId;
}

async function importThreadReplies({
  gitterRoomId,
  matrixRoomId,
  matrixHistoricalRoomId,
  threadParentId,
  resumeFromMessageId,
  stopAtMessageId
}) {
  assert(gitterRoomId);
  assert(matrixRoomId);
  assert(matrixHistoricalRoomId);
  assert(threadParentId);
  assert(resumeFromMessageId);
  // stopAtMessageId is not required since it's possible we have not bridged any
  // messages in this room.
  //
  //assert(stopAtMessageId);

  const threadReplyMessageCursor = persistence.ChatMessage.find({
    _id: (() => {
      const idQuery = {
        $gt: resumeFromMessageId
      };

      if (stopAtMessageId) {
        // Protect from the edge-case scenario where the first live bridged message in the
        // room was a reply to a thread. We should only import up to the live point since
        // we can't have duplicate entries in the `MatrixBridgedChatMessageSchema`
        idQuery['$lt'] = stopAtMessageId;
      }

      return idQuery;
    })(),
    toTroupeId: gitterRoomId,
    // No threaded messages in our main iterable.
    parentId: threadParentId,
    // Although we probably won't find any Matrix bridged messages in the old
    // batch of messages we try to backfill, let's just be careful and not try
    // to re-bridge any previously bridged Matrix messages by accident.
    virtualUser: { $exists: false }
  })
    // Go from oldest to most recent so everything appears in the order it was sent in
    // the first place
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_MESSAGES)
    .cursor()
    // Try to stop `MongoError: connection XX to mongo-replica-xx timed out`
    .addCursorFlag('noCursorTimeout', true);
  const threadReplyMessageStreamIterable = iterableFromMongooseCursor(threadReplyMessageCursor);

  // eslint-disable-next-line no-use-before-define
  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable: threadReplyMessageStreamIterable,
    stopAtMessageId
  });
}

async function importFromChatMessageStreamIterable({
  gitterRoomId,
  matrixHistoricalRoomId,
  chatMessageStreamIterable,
  stopAtMessageId
}) {
  try {
    let runningEventImportCount = 0;
    let lastImportMetricReportTs = Date.now();
    for await (let message of chatMessageStreamIterable) {
      // To avoid spamming our stats server, only send stats 1/N of the time
      const { performanceMark, performanceClearMarks, performanceMeasure } = sampledPerformance(
        METRIC_SAMPLE_RATIO
      );

      performanceMark(`importMessageStart`);
      const gitterMessageId = message.id || message._id;
      const matrixId = await _getOrCreateMatrixUserByGitterUserIdCached(message.fromUserId);
      const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, message);

      // Will send message and join the room if necessary
      const messageSendAndStorePromise = new Promise(async (resolve, reject) => {
        try {
          performanceMark(`request.sendEventRequestStart`);
          const eventId = await matrixUtils.sendEventAtTimestmap({
            type: 'm.room.message',
            matrixRoomId: matrixHistoricalRoomId,
            mxid: matrixId,
            matrixContent,
            timestamp: new Date(message.sent).getTime()
          });

          performanceMark(`request.sendEventRequestEnd`);
          await matrixStore.storeBridgedMessage(message, matrixHistoricalRoomId, eventId);
          performanceMark(`importMessageEnd`);

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      // Assign this so we safely finish the send we're working on before shutting down
      roomIdTofinalPromiseToAwaitBeforeShutdownMap.set(
        String(gitterRoomId),
        messageSendAndStorePromise
      );
      // Then actually wait for the work to be done
      await messageSendAndStorePromise;

      stats.eventHF('matrix-bridge.import.event', 1, METRIC_SAMPLE_RATIO);

      performanceMeasure(
        'matrix-bridge.event_send_request.time',
        'request.sendEventRequestStart',
        'request.sendEventRequestEnd'
      );
      performanceMeasure(
        'matrix-bridge.import_message.time',
        'importMessageStart',
        'importMessageEnd'
      );

      performanceClearMarks(`request.sendEventRequestStart`);
      performanceClearMarks(`request.sendEventRequestEnd`);
      performanceClearMarks(`importMessageStart`);
      performanceClearMarks(`importMessageEnd`);

      runningEventImportCount++;
      // Only report back every 1/4 of a second
      if (Date.now() - lastImportMetricReportTs >= QUARTER_SECOND_IN_MS) {
        matrixHistoricalImportEventEmitter.emit('eventImported', {
          gitterRoomId,
          count: runningEventImportCount
        });

        // Reset the running count after we report it
        runningEventImportCount = 0;
        lastImportMetricReportTs = Date.now();
      }

      // Import all thread replies after the thread parent
      if (message.threadMessageCount) {
        await importThreadReplies({
          gitterRoomId,
          matrixRoomId: matrixHistoricalRoomId,
          matrixHistoricalRoomId,
          threadParentId: gitterMessageId,
          // Any message with an ID greater than the thread parent is good (this means
          // every thread reply)
          resumeFromMessageId: gitterMessageId,
          stopAtMessageId
        });
      }
    }

    // Send the final amount of messages that were left over when we were done
    if (runningEventImportCount > 0) {
      matrixHistoricalImportEventEmitter.emit('eventImported', {
        gitterRoomId,
        count: runningEventImportCount
      });
    }
  } finally {
    // We are done importing so we no longer need to worry about this anymore (clean-up
    // so the map doesn't grow forever)
    roomIdTofinalPromiseToAwaitBeforeShutdownMap.delete(String(gitterRoomId));
  }
}

// eslint-disable-next-line complexity
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
    `Starting import of main messages for ${
      gitterRoom.oneToOne ? 'ONE_TO_ONE' : gitterRoom.uri
    } (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (live matrixRoomId=${matrixRoomId})`
  );

  // Where to resume from
  const lastBridgedMessageEntryInHistoricalRoom = await findLatestBridgedMessageInRoom(
    matrixHistoricalRoomId
  );
  const gitterMessageIdToResumeFrom =
    lastBridgedMessageEntryInHistoricalRoom &&
    lastBridgedMessageEntryInHistoricalRoom.gitterMessageId;
  if (gitterMessageIdToResumeFrom) {
    debug(
      `Resuming from gitterMessageIdToResumeFrom=${gitterMessageIdToResumeFrom} matrixEventId=${lastBridgedMessageEntryInHistoricalRoom.matrixEventId} (matrixHistoricalRoomId=${matrixHistoricalRoomId})`
    );
  }

  // Where we should stop importing at because the live room will pick up from this point.
  const firstBridgedMessageEntryInLiveRoom = await findEarliestBridgedMessageInRoom(matrixRoomId);
  const gitterMessageIdToStopImportingAt =
    firstBridgedMessageEntryInLiveRoom && firstBridgedMessageEntryInLiveRoom.gitterMessageId;
  if (gitterMessageIdToStopImportingAt) {
    debug(
      `Stopping import at gitterMessageIdToStopImportingAt=${gitterMessageIdToStopImportingAt} where the live room picks up from - matrixEventId=${firstBridgedMessageEntryInLiveRoom.matrixEventId} (matrixRoomId=${matrixRoomId})`
    );
  }

  // If we see that the resume position is a thread reply or we stopped at a thread
  // parent, then we need to finish off that thread first before moving on to the main
  // messages again. We must have failed out in the middle of the thread before.
  if (gitterMessageIdToResumeFrom) {
    const gitterMessageToResumeFrom = await chatService.findByIdLean(gitterMessageIdToResumeFrom);
    const isInThread = gitterMessageToResumeFrom.parentId;
    const isThreadParent = gitterMessageToResumeFrom.threadMessageCount > 0;

    let threadParentId;
    if (isThreadParent) {
      threadParentId = gitterMessageToResumeFrom.id || gitterMessageToResumeFrom._id;
    } else if (isInThread) {
      threadParentId = gitterMessageToResumeFrom.parentId;
    }

    if (threadParentId) {
      debug(
        `Resuming threadParentId=${threadParentId} before continuing to main message loop (matrixRoomId=${matrixRoomId})`
      );

      await importThreadReplies({
        gitterRoomId,
        matrixRoomId,
        matrixHistoricalRoomId,
        threadParentId,
        // Resume and finish importing the thread we left off at
        resumeFromMessageId: gitterMessageIdToResumeFrom,
        stopAtMessageId: gitterMessageIdToStopImportingAt
      });
    }
  }

  // Grab a cursor stream of all of the main messages in the room (no thread replies).
  // Resume from where we left off importing last time and stop when we reach the point
  // where the live room will continue seamlessly.
  const chatMessageQuery = {
    // Start the stream of messages where we left off, earliest message, going forwards
    _id: (() => {
      const idQuery = {};
      // Where to resume from
      if (gitterMessageIdToResumeFrom) {
        idQuery['$gt'] = gitterMessageIdToResumeFrom;
      }
      // Where we should stop importing at because the live room will pick up from this point
      if (gitterMessageIdToStopImportingAt) {
        idQuery['$lt'] = gitterMessageIdToStopImportingAt;
      }

      // If we haven't imported any history yet, just fallback to an `exists` (get all messages)
      if (!gitterMessageIdToResumeFrom && !gitterMessageIdToStopImportingAt) {
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
  };
  const messageCursor = persistence.ChatMessage.find(chatMessageQuery)
    // Go from oldest to most recent so everything appears in the order it was sent in
    // the first place
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE_FOR_MESSAGES)
    .cursor()
    // Try to stop `MongoError: connection XX to mongo-replica-xx timed out`
    .addCursorFlag('noCursorTimeout', true);
  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable,
    stopAtMessageId: gitterMessageIdToStopImportingAt
  });

  debug(
    `Done importing of messages for ${
      gitterRoom.oneToOne ? 'ONE_TO_ONE' : gitterRoom.uri
    } (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (live matrixRoomId=${matrixRoomId})`
  );
}

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
//   another thing to do. Update: This is now tracked by
//   https://github.com/vector-im/element-web/issues/24036
// - Also since Hydrogen doesn't support threads yet, the threads won't be visible in
//   the Matrix Public Archive or if they are, it will just be a big chunk where all the
//   thread reply fallbacks will be. It will be better if we can import messages one by
//   one and mix the thread replies right under the thread parent for easy viewing in
//   clients where threads aren't supported.
//
async function gitterToMatrixHistoricalImport(gitterRoomId) {
  const gitterRoom = await troupeService.findByIdLean(gitterRoomId);

  // Ignore Matrix DMs, rooms under the matrix/ group (matrixDmGroupUri). By their
  // nature, they have been around since the Matrix bridge so there is nothing to
  // import.
  const matrixDmGroupUri = 'matrix';
  const matrixDmGroup = await groupService.findByUri(matrixDmGroupUri, { lean: true });
  if (
    matrixDmGroup &&
    mongoUtils.objectIDsEqual(gitterRoom.groupId, matrixDmGroup.id || matrixDmGroup._id)
  ) {
    debug(`Skipping Matrix DM (gitterRoomId=${gitterRoomId})`);
    return;
  }

  // Find our current live Matrix room
  let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );
  debug(
    `Found matrixHistoricalRoomId=${matrixHistoricalRoomId} matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  await importMessagesFromGitterRoomToHistoricalMatrixRoom({
    gitterRoom,
    matrixRoomId,
    matrixHistoricalRoomId
  });

  await matrixUtils.ensureCorrectHistoricalMatrixRoomStateAfterImport({
    matrixRoomId,
    matrixHistoricalRoomId,
    gitterRoomId
  });
}

module.exports = {
  gitterToMatrixHistoricalImport,
  matrixHistoricalImportEventEmitter
};
