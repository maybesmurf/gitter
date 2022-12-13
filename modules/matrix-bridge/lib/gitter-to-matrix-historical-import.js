'use strict';

const assert = require('assert');
const LRU = require('lru-cache');
const debug = require('debug')('gitter:app:matrix-bridge:gitter-to-matrix-historical-import');

const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const chatService = require('gitter-web-chats');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');

const matrixUtils = new MatrixUtils(matrixBridge);

const DB_BATCH_SIZE = 100;

// Find the earliest-in-time message that we have already bridged,
// ie. where we need to stop backfilling from to resume (resumability)
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
    .select({ _id: 0, gitterMessageId: 1 })
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
    id: (() => {
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
    .batchSize(DB_BATCH_SIZE)
    .cursor();
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
  for await (let message of chatMessageStreamIterable) {
    const messageId = message.id || message._id;
    const matrixId = await _getOrCreateMatrixUserByGitterUserIdCached(message.fromUserId);
    const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, message);

    // Will send message and join the room if necessary
    const eventId = await matrixUtils.sendEventAtTimestmap({
      type: 'm.room.message',
      matrixRoomId: matrixHistoricalRoomId,
      mxid: matrixId,
      matrixContent,
      timestamp: new Date(message.sent).getTime()
    });
    await matrixStore.storeBridgedMessage(message, matrixHistoricalRoomId, eventId);

    // Import all thread replies after the thread parent
    if (message.threadMessageCount) {
      await importThreadReplies({
        gitterRoomId,
        matrixRoomId: matrixHistoricalRoomId,
        matrixHistoricalRoomId,
        threadParentId: messageId,
        // Any message with an ID greater than the thread parent is good (this means
        // every thread reply)
        resumeFromMessageId: messageId,
        stopAtMessageId
      });
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
    `Starting import of main messages for ${gitterRoom.uri} (${gitterRoomId}) --> matrixHistoricalRoomId=${matrixHistoricalRoomId} (live matrixRoomId=${matrixRoomId})`
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
      `Resuming from gitterMessageIdToResumeFrom=${gitterMessageIdToResumeFrom} matrixEventId=${lastBridgedMessageEntryInHistoricalRoom.matrixEventId} (matrixRoomId=${matrixRoomId})`
    );
  }

  // Where we should stop importing at because the live room will pick up from this point
  const firstBridgedMessageEntryInLiveRoom = await findEarliestBridgedMessageInRoom(matrixRoomId);
  const gitterMessageIdToStopImportingAt =
    firstBridgedMessageEntryInLiveRoom && firstBridgedMessageEntryInLiveRoom.gitterMessageId;

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
  const messageCursor = persistence.ChatMessage.find({
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
  })
    // Go from oldest to most recent so everything appears in the order it was sent in
    // the first place
    .sort({ _id: 'asc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(DB_BATCH_SIZE)
    .cursor();

  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable,
    stopAtMessageId: gitterMessageIdToStopImportingAt
  });
}

async function gitterToMatrixHistoricalImport(gitterRoomId) {
  const gitterRoom = await troupeService.findByIdLean(gitterRoomId);

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
  gitterToMatrixHistoricalImport
};
