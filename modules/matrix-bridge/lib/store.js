'use strict';

// Some reference: https://github.com/matrix-org/matrix-bifrost/blob/develop/src/store/Store.ts

const assert = require('assert');
const persistence = require('gitter-web-persistence');

async function getGitterRoomIdByMatrixRoomId(matrixRoomId) {
  const bridgedRoomEntry = await persistence.MatrixBridgedRoom.findOne({
    matrixRoomId
  });

  if (bridgedRoomEntry) {
    return bridgedRoomEntry.troupeId;
  }
}

async function getMatrixRoomIdByGitterRoomId(gitterRoomId) {
  const bridgedRoomEntry = await persistence.MatrixBridgedRoom.findOne({
    troupeId: gitterRoomId
  }).exec();

  if (bridgedRoomEntry) {
    return bridgedRoomEntry.matrixRoomId;
  }
}
async function getHistoricalMatrixRoomIdByGitterRoomId(gitterRoomId) {
  const bridgedRoomEntry = await persistence.MatrixBridgedHistoricalRoom.findOne({
    troupeId: gitterRoomId
  }).exec();

  if (bridgedRoomEntry) {
    return bridgedRoomEntry.matrixRoomId;
  }
}

async function getMatrixUserIdByGitterUserId(gitterUserId) {
  const bridgedUserEntry = await persistence.MatrixBridgedUser.findOne({
    userId: gitterUserId
  }).exec();
  if (bridgedUserEntry) {
    return bridgedUserEntry.matrixId;
  }
}

async function getGitterUserIdByMatrixUserId(matrixId) {
  const bridgedUserEntry = await persistence.MatrixBridgedUser.findOne({
    matrixId
  }).exec();
  if (bridgedUserEntry) {
    return bridgedUserEntry.userId;
  }
}

async function getBridgedMessageEntryByGitterMessageId(gitterMessageId) {
  const bridgedMessageEntry = await persistence.MatrixBridgedChatMessage.findOne({
    gitterMessageId
  }).exec();
  return bridgedMessageEntry;
}

async function getMatrixEventIdByGitterMessageId(gitterMessageId) {
  const bridgedMessageEntry = await getBridgedMessageEntryByGitterMessageId(gitterMessageId);
  if (bridgedMessageEntry) {
    return bridgedMessageEntry.matrixEventId;
  }
}

async function getGitterMessageIdByMatrixEventId(matrixRoomId, matrixEventId) {
  const bridgedMessageEntry = await persistence.MatrixBridgedChatMessage.findOne({
    matrixRoomId,
    matrixEventId
  }).exec();
  if (bridgedMessageEntry) {
    return bridgedMessageEntry.gitterMessageId;
  }
}

// Stores a bridge room entry and overwrites any existing entry with the same gitterRoomId or matrixRoomId
async function storeBridgedRoom(gitterRoomId, matrixRoomId) {
  return persistence.MatrixBridgedRoom.update(
    {
      $or: [
        {
          troupeId: gitterRoomId
        },
        {
          matrixRoomId
        }
      ]
    },
    {
      troupeId: gitterRoomId,
      matrixRoomId
    },
    {
      upsert: true,
      new: true
    }
  );
}

async function storeBridgedUser(gitterUserId, matrixId) {
  return persistence.MatrixBridgedUser.create({
    userId: gitterUserId,
    matrixId
  });
}

async function storeBridgedMessage(gitterMessage, matrixRoomId, matrixEventId) {
  assert(gitterMessage);
  assert(matrixRoomId);
  assert(matrixEventId);
  return persistence.MatrixBridgedChatMessage.create({
    gitterMessageId: gitterMessage.id || gitterMessage._id,
    matrixRoomId,
    matrixEventId,
    sent: gitterMessage.sent,
    editedAt: gitterMessage.editedAt
  });
}

async function storeUpdatedBridgedGitterMessage(gitterMessage) {
  return persistence.MatrixBridgedChatMessage.update({
    $set: {
      sent: gitterMessage.sent,
      editedAt: gitterMessage.editedAt
    }
  });
}

module.exports = {
  // Rooms
  getGitterRoomIdByMatrixRoomId,
  getMatrixRoomIdByGitterRoomId,
  storeBridgedRoom,
  // Historical Rooms (where we import all our back catalog of messages)
  getHistoricalMatrixRoomIdByGitterRoomId,

  // Users
  getMatrixUserIdByGitterUserId,
  getGitterUserIdByMatrixUserId,
  storeBridgedUser,

  // Messages
  getBridgedMessageEntryByGitterMessageId,
  getGitterMessageIdByMatrixEventId,
  getMatrixEventIdByGitterMessageId,
  storeBridgedMessage,
  storeUpdatedBridgedGitterMessage
};
