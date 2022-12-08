#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { PerformanceObserver } = require('perf_hooks');
const shutdown = require('shutdown');
const debug = require('debug')('gitter:scripts:matrix-historical-import');
const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const persistence = require('gitter-web-persistence');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const { iterableFromMongooseCursor } = require('gitter-web-persistence-utils/lib/mongoose-utils');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const importFromChatMessageStreamIterable = require('./matrix-historical-import/import-from-chat-message-stream');

// The number of messages per MSC2716 import batch
const BATCH_SIZE = 100;

const matrixUtils = new MatrixUtils(matrixBridge);

// Will log out any `performance.measure(...)` calls in subsequent code
const observer = new PerformanceObserver(list =>
  list.getEntries().forEach(entry => {
    console.log('entry', entry);
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

async function handleMainMessages(gitterRoom, matrixRoomId) {
  const gitterRoomId = gitterRoom.id || gitterRoom._id;
  logger.info(
    `Starting import of main messages for ${gitterRoom.uri} (${gitterRoomId}) <-> ${matrixRoomId}`
  );
  // Find the earliest-in-time message that we have already bridged,
  // ie. where we need to start backfilling from to resume (resumability)
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
  if (firstBridgedMessageIdInRoom) {
    debug(
      `Resuming from firstBridgedMessageInRoom=${JSON.stringify(
        firstBridgedMessageIdInRoom
      )} (matrixRoomId=${matrixRoomId})`
    );
  }

  const messageCursor = persistence.ChatMessage.find({
    // Start the stream of messages where we left off
    _id: (() => {
      if (firstBridgedMessageIdInRoom) {
        return { $lt: firstBridgedMessageIdInRoom.gitterMessageId };
      }
      return { $exists: true };
    })(),
    toTroupeId: gitterRoomId,
    // Although we probably won't find any Matrix bridged messages in the old
    // batch of messages we try to backfill, let's just be careful and not try
    // to re-bridge any previously bridged Matrix messages by accident.
    virtualUser: { $exists: false }
  })
    .sort({ _id: 'desc' })
    .lean()
    .read(mongoReadPrefs.secondaryPreferred)
    .batchSize(BATCH_SIZE)
    .cursor();

  const chatMessageStreamIterable = iterableFromMongooseCursor(messageCursor);

  await importFromChatMessageStreamIterable({
    gitterRoom,
    matrixRoomId,
    chatMessageStreamIterable,
    batchSize: BATCH_SIZE
  });
}

async function handleThreadedConversationRelations(gitterRoom, matrixRoomId) {
  const gitterRoomId = gitterRoom.id || gitterRoom._id;
  logger.info(
    `Starting import of threaded conversations for ${gitterRoom.uri} (${gitterRoomId}) <-> ${matrixRoomId}`
  );
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

  await importFromChatMessageStreamIterable({
    gitterRoom,
    matrixRoomId,
    chatMessageStreamIterable: threadedMessageStreamIterable,
    batchSize: BATCH_SIZE
  });
}

// eslint-disable-next-line max-statements
async function exec() {
  logger.info('Setting up Matrix bridge');
  await installBridge();

  const gitterRoom = await troupeService.findByUri(opts.uri);
  const gitterRoomId = gitterRoom.id || gitterRoom._id;

  //const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  const matrixRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );
  // TODO: Handle DM
  debug(
    `Found matrixRoomId=${matrixRoomId} for given Gitter room ${gitterRoom.uri} (${gitterRoomId})`
  );

  // TODO: We can only backfill in rooms which we can control
  // because we know the @gitter-badger:gitter.im is the room creator
  // which is the only user who can backfill in existing room versions.

  await handleMainMessages(gitterRoom, matrixRoomId);
  await handleThreadedConversationRelations(gitterRoom, matrixRoomId);

  // TODO: Ensure tombstone event pointing to main room
  // matrixUtils.ensureStateEvent(matrixRoomId, 'm.room.tombstone', {
  //   "replacement_room": TODO
  // });
}

exec()
  .then(() => {
    logger.info(`Successfully imported all historical messages for ${opts.uri}`);
    shutdown.shutdownGracefully();
  })
  .catch(err => {
    logger.error('Error occurred while backfilling events:', err.stack);
    shutdown.shutdownGracefully();
  });
