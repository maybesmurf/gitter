'use strict';

const assert = require('assert');
const debug = require('debug')(
  'gitter:scripts:matrix-historical-import:handle-threaded-conversation-relations'
);
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');
const { MSC2716_HISTORICAL_CONTENT_FIELD } = require('./constants');
assert(MSC2716_HISTORICAL_CONTENT_FIELD);
const getMatrixProfileFromGitterUserId = require('./get-matrix-profile-from-gitter-user-id');

const BATCH_SIZE = 100;

async function processBatchOfEvents(matrixRoomId, eventEntries) {
  assert(matrixRoomId);
  assert(eventEntries);

  for (const eventEntry of eventEntries) {
    const mxid = eventEntry.matrixEvent.sender;
    const intent = matrixBridge.getIntent(mxid);

    const matrixContent = eventEntry.matrixEvent.content;

    const { event_id } = await intent.sendMessage(matrixRoomId, matrixContent);

    // Store the message so we can reference it in edits and threads/replies
    // debug(
    //   `Storing bridged message (Gitter message id=${eventEntry.gitterMessage.id} -> Matrix matrixRoomId=${matrixRoomId} event_id=${event_id})`
    // );
    // await matrixStore.storeBridgedMessage(eventEntry.gitterMessage, matrixRoomId, event_id);
  }
}

async function handleThreadedConversationRelations(gitterRoom, matrixRoomId) {
  assert(gitterRoom);
  assert(matrixRoomId);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  const threadedMessageCursor = persistence.ChatMessage.find({
    // TODO: Start the stream of messages where we left off
    //_id: { $lt: firstBridgedMessageIdInRoom.gitterMessageId },
    toTroupeId: gitterRoomId,
    parentId: { $exists: true },
    // We don't want to re-bridge any previously bridged Matrix messages
    // by accident.
    virtualUser: { $exists: false }
  })
    .sort({ _id: 'desc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(BATCH_SIZE)
    .cursor();

  const threadedMessageStreamIterable = iterableFromMongooseCursor(threadedMessageCursor);

  let eventEntries = [];

  // Just a small wrapper around processing that can process and reset
  let batchCount = 0;
  const _processBatch = async function() {
    await processBatchOfEvents(matrixRoomId, eventEntries);

    // Reset the batch now that it was processed
    eventEntries = [];
    // Increment the batch count
    batchCount += 1;
  };

  for await (let message of threadedMessageStreamIterable) {
    const messageId = message.id || message._id;
    const existingMatrixEventId = await matrixStore.getMatrixEventIdByGitterMessageId(messageId);
    assert(existingMatrixEventId);

    const parentMatrixEventId = await matrixStore.getMatrixEventIdByGitterMessageId(
      message.parentId
    );
    assert(parentMatrixEventId);

    const { mxid } = await getMatrixProfileFromGitterUserId(message.fromUserId);

    const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, message);
    matrixContent[MSC2716_HISTORICAL_CONTENT_FIELD] = true;

    const fallbackMatrixContent = {
      ...matrixContent,
      body: `* ${matrixContent.body}`,
      formatted_body: `* ${matrixContent.formatted_body}`
    };

    // Message event
    eventEntries.push({
      gitterMessage: message,
      matrixEvent: {
        type: 'm.room.message',
        sender: mxid,
        //origin_server_ts: new Date(message.sent).getTime(),
        content: {
          ...fallbackMatrixContent,
          'm.new_content': {
            ...matrixContent,
            // Make the message reply to the previous message in the thread
            'm.relates_to': {
              'm.in_reply_to': {
                event_id: parentMatrixEventId
              }
            }
          },
          // This points to the existing Matrix event we want to edit/replace
          'm.relates_to': {
            event_id: existingMatrixEventId,
            rel_type: 'm.replace'
          }
        }
      }
    });

    if (eventEntries.length >= BATCH_SIZE) {
      await _processBatch();
    }
  }

  // Process the remainder last batch
  await _processBatch();
}

module.exports = handleThreadedConversationRelations;
