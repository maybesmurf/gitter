'use strict';

const chatService = require('gitter-web-chats');

const transformGitterTextIntoMatrixMessage = require('./transform-gitter-text-into-matrix-message');
const store = require('./store');

async function generateMatrixContentFromGitterMessage(gitterRoomId, model) {
  const matrixCompatibleText = transformGitterTextIntoMatrixMessage(model.text, model);
  const matrixCompatibleHtml = transformGitterTextIntoMatrixMessage(model.html, model);

  let msgtype = 'm.text';
  // Check whether it's a `/me` status message
  if (model.status) {
    msgtype = 'm.emote';
  }

  const matrixContent = {
    body: matrixCompatibleText,
    format: 'org.matrix.custom.html',
    formatted_body: matrixCompatibleHtml,
    msgtype
  };

  // Handle threaded conversations
  let parentMatrixEventId;
  let lastMatrixEventIdInThread;
  if (model.parentId) {
    parentMatrixEventId = await store.getMatrixEventIdByGitterMessageId(model.parentId);

    // Try to reference the last message in thread
    // Otherwise, will just reference the thread parent
    const lastMessagesInThread = await chatService.findThreadChatMessages(
      gitterRoomId,
      model.parentId,
      {
        beforeId: model.id,
        limit: 1
      }
    );

    let lastMessageId = model.parentId;
    if (lastMessagesInThread.length > 0) {
      lastMessageId = lastMessagesInThread[0].id;
    }

    lastMatrixEventIdInThread = await store.getMatrixEventIdByGitterMessageId(lastMessageId);
  }

  // Handle threaded conversations
  if (parentMatrixEventId) {
    matrixContent['m.relates_to'] = {
      rel_type: 'm.thread',
      // Always reference thread root for the thread
      event_id: parentMatrixEventId,
      // Handle the reply fallback
      is_falling_back: true,
      'm.in_reply_to': {
        // But the reply fallback should reference the last message in the thread.
        // This could be the same as the thread root if there are no other thread
        // replies yet.
        event_id: lastMatrixEventIdInThread
      }
    };
  }

  return matrixContent;
}

module.exports = generateMatrixContentFromGitterMessage;
