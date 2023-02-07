'use strict';

const assert = require('assert');
const LRU = require('lru-cache');
const { performance } = require('perf_hooks');
const { EventEmitter } = require('events');
const shutdown = require('shutdown');
const debug = require('debug')('gitter:app:matrix-bridge:gitter-to-matrix-historical-import');
const debugStats = require('debug')('gitter:scripts:matrix-historical-import:stats');

const env = require('gitter-web-env');
const logger = env.logger;
const stats = env.stats;
const config = env.config;
const persistence = require('gitter-web-persistence');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const mongoReadPrefs = require('gitter-web-persistence-utils/lib/mongo-read-prefs');
const {
  noTimeoutIterableFromMongooseCursor
} = require('gitter-web-persistence-utils/lib/mongoose-utils');
const groupService = require('gitter-web-groups');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const chatService = require('gitter-web-chats');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');
const generateMatrixContentFromGitterMessage = require('gitter-web-matrix-bridge/lib/generate-matrix-content-from-gitter-message');
const formatDurationInMsToPrettyString = require('gitter-web-matrix-bridge/lib/format-duration-in-ms-to-pretty-string');
const RethrownError = require('./rethrown-error');

// The number of chat messages we pull out at once to reduce database roundtrips
const DB_BATCH_SIZE_FOR_MESSAGES = 100;
// "secondary", "secondaryPreferred", etc
// https://www.mongodb.com/docs/manual/core/read-preference/#read-preference
//
// This is an option because I often see it reading from the primary with
// "secondaryPreferred" and want to try forcing it to "secondary".
const DB_READ_PREFERENCE =
  config.get('gitterToMatrixHistoricalImport:databaseReadPreference') ||
  mongoReadPrefs.secondaryPreferred;
const METRIC_SAMPLE_RATIO = 1 / 15;

const QUARTER_SECOND_IN_MS = 250;

const NEXT_MESSAGE_FROM_DB_ITERABLE_METRIC_NAME =
  'matrix-bridge.next_message_from_db_iterable.time';

const matrixUtils = new MatrixUtils(matrixBridge);

const matrixHistoricalImportEventEmitter = new EventEmitter();

const hitRoomCollisionAndDoneImportingRoomSymbol = Symbol(
  'hit-room-collision-and-done-importing-room'
);

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

function sampledPerformance({
  // Only actually record metrics at this frequency
  frequency,
  // Something unique for this scope so we don't collide with other async things going on
  markSuffix
}) {
  assert(frequency);
  assert(markSuffix);

  if (Math.random() < frequency) {
    return {
      performanceMark: (name, markOptions) => {
        performance.mark(`${name}${markSuffix}`, markOptions);
      },
      performanceClearMarks: name => {
        assert(name);
        performance.clearMarks(`${name}${markSuffix}`);
      },
      performanceMeasure: (measureName, startMark, endMark) => {
        performance.measure(measureName, `${startMark}${markSuffix}`, `${endMark}${markSuffix}`);
      }
    };
  }

  return {
    performanceMark: () => {},
    performanceClearMarks: () => {},
    performanceMeasure: () => {}
  };
}

// Take in another generator and filter it down to only the main messages (no threaded
// replies). We do the filtering here so we can use a simple database lookup against an
// index.
//
//Returns another generator
async function* filteredMainChatMessageStreamIterable(chatMessageStreamIterable) {
  for await (const chatMessage of chatMessageStreamIterable) {
    if (
      // No threaded messages in our main messages iterable.
      !chatMessage.parentId &&
      // Although we probably won't find any Matrix bridged messages in the old
      // batch of messages we try to backfill, let's just be careful and not try
      // to re-bridge any previously bridged Matrix messages by accident.
      !chatMessage.virtualUser
    ) {
      yield chatMessage;
    }
  }
}

// Take in another generator and filter it down to only the threaded replies we care
// about. We do the filtering here so we can use a simple database lookup against an
// index.
//
//Returns another generator
async function* filteredThreadedReplyMessageStreamIterable(chatMessageStreamIterable) {
  for await (const chatMessage of chatMessageStreamIterable) {
    if (
      // Although we probably won't find any Matrix bridged messages in the old
      // batch of messages we try to backfill, let's just be careful and not try
      // to re-bridge any previously bridged Matrix messages by accident.
      !chatMessage.virtualUser
    ) {
      yield chatMessage;
    }
  }
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

  const threadReplyMessageStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      const threadReplyMessageCursor = persistence.ChatMessage.find({
        _id: (() => {
          const idQuery = {
            $gt: previousIdFromCursor || resumeFromMessageId
          };

          if (stopAtMessageId) {
            // Protect from the edge-case scenario where the first live bridged message in the
            // room was a reply to a thread. We should only import up to the live point since
            // we can't have duplicate entries in the `MatrixBridgedChatMessageSchema`
            idQuery['$lt'] = stopAtMessageId;
          }

          return idQuery;
        })(),
        // Only get threaded replies in this thread
        parentId: threadParentId
        // We don't need to filter by `toTroupeId` since we already filter by thread parent
        // ID which is good enough.
        //
        //toTroupeId: gitterRoomId,
      })
        // Go from oldest to most recent so everything appears in the order it was sent in
        // the first place
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_MESSAGES)
        .cursor();

      return { cursor: threadReplyMessageCursor, batchSize: DB_BATCH_SIZE_FOR_MESSAGES };
    }
  );

  const filteredThreadReplyMessageStreamIterable = filteredThreadedReplyMessageStreamIterable(
    threadReplyMessageStreamIterable
  );

  // eslint-disable-next-line no-use-before-define
  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable: filteredThreadReplyMessageStreamIterable,
    stopAtMessageId
  });
}

// eslint-disable-next-line max-statements, complexity
async function importFromChatMessageStreamIterable({
  gitterRoomId,
  matrixRoomId,
  matrixHistoricalRoomId,
  chatMessageStreamIterable,
  stopAtMessageId
}) {
  assert(gitterRoomId);
  assert(matrixRoomId);
  assert(matrixHistoricalRoomId);
  assert(chatMessageStreamIterable);
  // stopAtMessageId is not required since it's possible we have not bridged any
  // messages in this room.
  //
  //assert(stopAtMessageId);

  try {
    let runningImportedMessageCount = 0;
    let lastImportMetricReportTs = Date.now();

    let beforeNextMessageTs = Date.now();
    let runningMessageCountForNextMessageTiming = 0;
    let runningTimeMsToGetNextMessage = 0;
    for await (let message of chatMessageStreamIterable) {
      const durationMsToGetNextMessage = Date.now() - beforeNextMessageTs;
      runningTimeMsToGetNextMessage += durationMsToGetNextMessage;
      // Only report after we have see a batch worth of messages to average the one time
      // batch fetch cost over all of the messages
      if (runningMessageCountForNextMessageTiming >= DB_BATCH_SIZE_FOR_MESSAGES) {
        // Record how long it took us just to iterate over the database cursor and pull
        // all the messages out. This is an average over the whole batch to give the
        // time to get a message from the database. This would also theoretically
        // translate to the maximum rate of messages we could import if importing took
        // zero time.
        const averageTimeToGetOneMessage =
          runningTimeMsToGetNextMessage / runningMessageCountForNextMessageTiming;
        stats.responseTime(NEXT_MESSAGE_FROM_DB_ITERABLE_METRIC_NAME, averageTimeToGetOneMessage);
        debugStats(
          `${NEXT_MESSAGE_FROM_DB_ITERABLE_METRIC_NAME} took ${formatDurationInMsToPrettyString(
            averageTimeToGetOneMessage
          )} on average to get a single message`
        );

        // Reset after reporting
        runningTimeMsToGetNextMessage = 0;
        runningMessageCountForNextMessageTiming = 0;
      }

      const gitterMessageId = message.id || message._id;

      // Although we probably won't find any Matrix bridged messages in the old
      // batch of messages we try to backfill, let's just be careful and not try
      // to re-bridge any previously bridged Matrix messages by accident.
      if (message.virtualUser) {
        debug(
          `Skipping gitterMessageId=${gitterMessageId} from Matrix virtualUser that we shouldn't rebridge (${gitterRoomId} --> matrixHistoricalRoomId=${matrixHistoricalRoomId})`
        );
        // Skip to the next message
        continue;
      }

      // To avoid spamming our stats server, only send stats 1/N of the time
      const { performanceMark, performanceClearMarks, performanceMeasure } = sampledPerformance({
        frequency: METRIC_SAMPLE_RATIO,
        markSuffix: gitterMessageId
      });

      performanceMark(`importMessageStart`);
      if (!message.fromUserId) {
        // Example:
        // ```
        // {
        //     "_id" : ObjectId("529f0bd24613267312000035"),
        //     "editedAt" : null,
        //     "fromUserId" : null,
        //     "issues" : [ ],
        //     "mentions" : [ ],
        //     "meta" : {
        //         "url" : "http://foo.bar/",
        //         "phase" : "started",
        //         "job" : "gitter-webapp-production",
        //         "service" : "jenkins",
        //         "type" : "webhook"
        //     },
        //     "readBy" : [
        //         ObjectId("529c6c1fed5ab0b3bf04d813")
        //     ],
        //     "sent" : ISODate("2013-12-04T11:02:42.963Z"),
        //     "skipAlerts" : true,
        //     "text" : "[Jenkins] Job gitter-webapp-production started http://foo.bar:8080/job/gitter-webapp-production/17/",
        //     "toTroupeId" : ObjectId("5298e324ed5ab0b3bf04c988"),
        //     "urls" : [ ],
        //     "lang" : "en"
        // }
        // ```
        logger.warn(
          `gitterMessageId=${gitterMessageId} from gitterRoomId=${gitterRoomId} unexpectedly did not have a fromUserId=${message.fromUserId}. This is probably a legacy webhook message in the main timeline.`
        );

        // Skip to the next message
        continue;
      }

      // Skip messages that were deleted by clearing out the text.
      //
      // We could get away with `!message.text` here but it's more obvious what were
      // avoiding with these explicit conditions.
      if (message.text === undefined || message.text === null || message.text.length === 0) {
        continue;
      }

      // Will send message and join the room if necessary
      // eslint-disable-next-line max-statements, complexity
      const messageSendAndStorePromise = new Promise(async (resolve, reject) => {
        try {
          const matrixId = await _getOrCreateMatrixUserByGitterUserIdCached(message.fromUserId);
          const matrixContent = await generateMatrixContentFromGitterMessage(gitterRoomId, message);

          performanceMark(`request.sendEventRequestStart`);
          const matrixEventId = await matrixUtils.sendEventAtTimestmap({
            type: 'm.room.message',
            matrixRoomId: matrixHistoricalRoomId,
            mxid: matrixId,
            matrixContent,
            timestamp: new Date(message.sent).getTime()
          });

          performanceMark(`request.sendEventRequestEnd`);
          try {
            await matrixStore.storeBridgedMessage(message, matrixHistoricalRoomId, matrixEventId);
          } catch (err) {
            // If we see a `E11000 duplicate key error collection:
            // gitter.matricesbridgedchatmessage index: gitterMessageId_1 dup key: { :
            // ObjectId('...') }`, then we know that this is a room where we were initially
            // bridging to a `gitter.im` "live" room and that community asked us to bridge to
            // their own Matrix room (custom plumb).
            //
            // The reason this error occurs is because our `stopAtMessageId` point is
            // wrong because we are looking at the first bridged message to their custom Matrix
            // room instead of our initial `gitter.im` "live" room which we no longer track.
            //
            // This error means the historical room reached the point where the old `gitter.im`
            // "live" room so technically we're done importing anyway (the messages exist on
            // Matrix somewhere but they will have to manage that chain themselves).
            //
            // The right thing to do is just to redact the event so we don't have any
            // dangling untracked event hanging around and so we don't have that overlap
            // with the old "live" room.
            if (mongoUtils.mongoErrorWithCode(11000)(err)) {
              // Delete the dangling message that we had a collision with but couldn't store
              try {
                const senderIntent = matrixBridge.getIntent(matrixId);
                await senderIntent.matrixClient.redactEvent(matrixHistoricalRoomId, matrixEventId);
              } catch (err) {
                // If we fail to delete the message from the Gitter user, let's just do it
                // from the bridging user (Gitter badger). This will happen whenever a
                // Gitter user tries to delete a message from someone on Matrix
                // (M_FORBIDDEN: Application service cannot masquerade as this user.)
                const bridgeIntent = matrixBridge.getIntent();
                await bridgeIntent.matrixClient.redactEvent(matrixHistoricalRoomId, matrixEventId);
              }

              logger.warn(
                `Signalling that we're done importing this custom plumbed room because we ran into the collision point where the historical room ran into our old \`gitter.im\` "live" room which is now a custom plumb to ${matrixRoomId}. All of the history is on Matrix somewhere so we're considering this good enough.`,
                {
                  exception: err
                }
              );

              // Signal that we should break out of the import loop for this room
              resolve(hitRoomCollisionAndDoneImportingRoomSymbol);
              return null;
            }

            throw err;
          }
          performanceMark(`importMessageEnd`);

          // Measure these within the try-catch because we can gurantee they have been
          // set within the try but if we crashed out in the middle and measured after,
          // the mark won't be set.
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

          resolve();
        } catch (err) {
          if (err.status === 413 && err.errcode === 'M_TOO_LARGE') {
            logger.warn(
              `Skipping gitterMessageId=${gitterMessageId} from gitterRoomId=${gitterRoomId} since it was too large to send (M_TOO_LARGE).`
            );

            // Skip to the next message
            resolve();
            return null;
          }

          let errorToThrow = err;
          // Special case from matrix-appservice-bridge/matrix-bot-sdk
          if (!err.stack && err.body && err.body.errcode && err.toJSON) {
            const serializedRequestAsError = err.toJSON();
            (serializedRequestAsError.request || {}).headers = {
              ...serializedRequestAsError.request.headers,
              Authorization: '<redacted>'
            };
            errorToThrow = new Error(
              `matrix-appservice-bridge/matrix-bot-sdk threw an error that looked more like a request object, see ${JSON.stringify(
                serializedRequestAsError
              )}`
            );
          }

          reject(
            new RethrownError(`Failed to import gitterMessageId=${gitterMessageId}`, errorToThrow)
          );
        } finally {
          performanceClearMarks(`request.sendEventRequestStart`);
          performanceClearMarks(`request.sendEventRequestEnd`);
          performanceClearMarks(`importMessageStart`);
          performanceClearMarks(`importMessageEnd`);
        }
      });

      // Assign this so we safely finish the send we're working on before shutting down
      roomIdTofinalPromiseToAwaitBeforeShutdownMap.set(
        String(gitterRoomId),
        messageSendAndStorePromise
      );
      // Then actually wait for the work to be done
      const messageSendAndStoreResult = await messageSendAndStorePromise;

      if (messageSendAndStoreResult === hitRoomCollisionAndDoneImportingRoomSymbol) {
        // Break out of the for-loop, we're done importing this room
        return null;
      }

      stats.eventHF('matrix-bridge.import.event', 1, METRIC_SAMPLE_RATIO);

      runningImportedMessageCount++;
      // Only report back every 1/4 of a second
      if (Date.now() - lastImportMetricReportTs >= QUARTER_SECOND_IN_MS) {
        matrixHistoricalImportEventEmitter.emit('eventImported', {
          gitterRoomId,
          count: runningImportedMessageCount
        });

        // Reset the running count after we report it
        runningImportedMessageCount = 0;
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

      beforeNextMessageTs = Date.now();
      runningMessageCountForNextMessageTiming++;
    }

    // Send the final amount of messages that were left over when we were done
    if (runningImportedMessageCount > 0) {
      matrixHistoricalImportEventEmitter.emit('eventImported', {
        gitterRoomId,
        count: runningImportedMessageCount
      });
    }

    // Send the final timing to get the last of the messages from the cursor
    if (runningMessageCountForNextMessageTiming > 0) {
      stats.responseTime(
        NEXT_MESSAGE_FROM_DB_ITERABLE_METRIC_NAME,
        runningTimeMsToGetNextMessage / runningMessageCountForNextMessageTiming
      );
    }
  } finally {
    // We are done importing so we no longer need to worry about this anymore (clean-up
    // so the map doesn't grow forever)
    roomIdTofinalPromiseToAwaitBeforeShutdownMap.delete(String(gitterRoomId));
  }
}

// eslint-disable-next-line complexity, max-statements
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
  const lastGitterMessageIdThatWasImported =
    lastBridgedMessageEntryInHistoricalRoom &&
    lastBridgedMessageEntryInHistoricalRoom.gitterMessageId;
  if (lastGitterMessageIdThatWasImported) {
    debug(
      `Resuming from lastGitterMessageIdThatWasImported=${lastGitterMessageIdThatWasImported} matrixEventId=${lastBridgedMessageEntryInHistoricalRoom.matrixEventId} (matrixHistoricalRoomId=${matrixHistoricalRoomId})`
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
  if (lastGitterMessageIdThatWasImported) {
    const lastGitterMessageThatWasImported = await chatService.findByIdLean(
      lastGitterMessageIdThatWasImported
    );
    if (lastGitterMessageThatWasImported) {
      const isInThread = lastGitterMessageThatWasImported.parentId;
      const isThreadParent = lastGitterMessageThatWasImported.threadMessageCount > 0;

      let threadParentId;
      if (isThreadParent) {
        threadParentId =
          lastGitterMessageThatWasImported.id || lastGitterMessageThatWasImported._id;
      } else if (isInThread) {
        threadParentId = lastGitterMessageThatWasImported.parentId;
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
          resumeFromMessageId: lastGitterMessageIdThatWasImported,
          stopAtMessageId: gitterMessageIdToStopImportingAt
        });
      }
    } else {
      logger.warn(
        `While importing in matrixHistoricalRoomId=${matrixHistoricalRoomId} (for gitterRoomId=${gitterRoomId}), lastGitterMessageIdThatWasImported=${lastGitterMessageIdThatWasImported} does not exist. This is kinda odd but we bridged this message before but someone has deleted their message on Gitter since then. I guess we just move on.`
      );
    }
  }

  const chatMessageStreamIterable = noTimeoutIterableFromMongooseCursor(
    ({ previousIdFromCursor }) => {
      // Grab a cursor stream of all of the main messages in the room (no thread replies).
      // Resume from where we left off importing last time and stop when we reach the point
      // where the live room will continue seamlessly.
      const chatMessageQuery = {
        // Start the stream of messages where we left off, earliest message, going forwards
        _id: (() => {
          const idQuery = {};
          // Where to resume from
          if (previousIdFromCursor || lastGitterMessageIdThatWasImported) {
            idQuery['$gt'] = previousIdFromCursor || lastGitterMessageIdThatWasImported;
          }
          // Where we should stop importing at because the live room will pick up from this point
          if (gitterMessageIdToStopImportingAt) {
            idQuery['$lt'] = gitterMessageIdToStopImportingAt;
          }

          // If we haven't imported any history yet, just fallback to an `exists` (get all messages)
          if (!idQuery['$gt'] && !idQuery['$lt']) {
            idQuery['$exists'] = true;
          }

          return idQuery;
        })(),
        toTroupeId: gitterRoomId
        // We filter out the threaded replies via
        // `filteredMainChatMessageStreamIterable(...)`. We assume there isn't that many
        // threaded replies compared to the amount of main messages so filtering client-side
        // is good enough.
        //
        //parentId: { $exists: false }
      };

      const messageCursor = persistence.ChatMessage.find(chatMessageQuery)
        // Go from oldest to most recent so everything appears in the order it was sent in
        // the first place
        .sort({ _id: 'asc' })
        .lean()
        .read(DB_READ_PREFERENCE)
        .batchSize(DB_BATCH_SIZE_FOR_MESSAGES)
        .cursor();

      return { cursor: messageCursor, batchSize: DB_BATCH_SIZE_FOR_MESSAGES };
    }
  );

  const filteredChatMessageStreamIterable = filteredMainChatMessageStreamIterable(
    chatMessageStreamIterable
  );

  await importFromChatMessageStreamIterable({
    gitterRoomId,
    matrixRoomId,
    matrixHistoricalRoomId,
    chatMessageStreamIterable: filteredChatMessageStreamIterable,
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
  const matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  const matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
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

// If historical room is read-only and has a tombstone (the state reached by
// `ensureCorrectHistoricalMatrixRoomStateAfterImport`), then we can assume that we're
// done importing.
//
// This is useful for custom plumbed rooms where we
// `hitRoomCollisionAndDoneImportingRoomSymbol` and assume that we're done importing.
async function _checkDoneImportingFromAssumptions({ matrixHistoricalRoomId }) {
  assert(matrixHistoricalRoomId);

  const bridgeIntent = matrixBridge.getIntent();

  let tombstoneInHistoricalRoom;
  try {
    tombstoneInHistoricalRoom = await bridgeIntent.getStateEvent(
      matrixHistoricalRoomId,
      'm.room.tombstone'
    );
  } catch (err) {
    // no-op
  }
  const hasTombstoneInMatrixRoom =
    tombstoneInHistoricalRoom && tombstoneInHistoricalRoom.replacement_room;

  const currentPowerLevelContentOfHistoricalRoom = await bridgeIntent.getStateEvent(
    matrixHistoricalRoomId,
    'm.room.power_levels'
  );
  const READ_ONLY_EVENT_POWER_LEVEL = 50;
  const isMatrixRoomReadOnly =
    currentPowerLevelContentOfHistoricalRoom.events_default === READ_ONLY_EVENT_POWER_LEVEL;

  let isAssumedDoneFromRoomBeingReadOnly = false;
  if (hasTombstoneInMatrixRoom && isMatrixRoomReadOnly) {
    isAssumedDoneFromRoomBeingReadOnly = true;
  }

  return isAssumedDoneFromRoomBeingReadOnly;
}

// Given a `gitterRoomId`, figure out if we're done importing messages into the historical Matrix room
async function isGitterRoomIdDoneImporting(gitterRoomId) {
  assert(mongoUtils.isLikeObjectId(gitterRoomId));

  // Find our current live Matrix room
  let matrixRoomId = await matrixUtils.getOrCreateMatrixRoomByGitterRoomId(gitterRoomId);
  // Find the historical Matrix room we should import the history into
  let matrixHistoricalRoomId = await matrixUtils.getOrCreateHistoricalMatrixRoomByGitterRoomId(
    gitterRoomId
  );

  // If there is no historical room, then we know we haven't even tried importing in this room
  // although we should have created a room with the call just before
  if (!matrixHistoricalRoomId) {
    return false;
  }

  const lastBridgedMessageEntryInHistoricalRoom = await findLatestBridgedMessageInRoom(
    matrixHistoricalRoomId
  );
  const lastGitterMessageIdThatWasImported =
    lastBridgedMessageEntryInHistoricalRoom &&
    lastBridgedMessageEntryInHistoricalRoom.gitterMessageId;

  // Where we should stop importing at because the live room will pick up from this point.
  const firstBridgedMessageEntryInLiveRoom = await findEarliestBridgedMessageInRoom(matrixRoomId);
  const gitterMessageIdToStopImportingAt =
    firstBridgedMessageEntryInLiveRoom && firstBridgedMessageEntryInLiveRoom.gitterMessageId;

  const numberOfMessagesRemainingToImport = await persistence.ChatMessage.count({
    _id: (() => {
      const idQuery = {};

      if (lastGitterMessageIdThatWasImported) {
        idQuery['$gt'] = lastGitterMessageIdThatWasImported;
      }

      if (gitterMessageIdToStopImportingAt) {
        idQuery['$lt'] = gitterMessageIdToStopImportingAt;
      }

      if (!lastGitterMessageIdThatWasImported && !gitterMessageIdToStopImportingAt) {
        idQuery['$exists'] = true;
      }

      return idQuery;
    })(),
    toTroupeId: gitterRoomId
  })
    // Go from oldest to most recent so everything appears in the order it was sent in
    // the first place
    .sort({ _id: 'asc' })
    .read(DB_READ_PREFERENCE)
    .exec();

  const isDoneFromImportingMessages = numberOfMessagesRemainingToImport === 0;

  debug(
    `isGitterRoomIdDoneImporting(gitterRoomId=${gitterRoomId}) -> numberOfMessagesRemainingToImport=${numberOfMessagesRemainingToImport} (lastBridgedMessageEntryInHistoricalRoom=${lastBridgedMessageEntryInHistoricalRoom}, gitterMessageIdToStopImportingAt=${gitterMessageIdToStopImportingAt})`
  );

  const isAssumedDoneFromRoomBeingReadOnly = await _checkDoneImportingFromAssumptions({
    matrixHistoricalRoomId
  });

  debug(
    `isGitterRoomIdDoneImporting(gitterRoomId=${gitterRoomId}) -> isDoneFromImportingMessages=${isDoneFromImportingMessages}, isAssumedDoneFromRoomBeingReadOnly=${isAssumedDoneFromRoomBeingReadOnly}`
  );

  return isDoneFromImportingMessages || isAssumedDoneFromRoomBeingReadOnly;
}

module.exports = {
  gitterToMatrixHistoricalImport,
  isGitterRoomIdDoneImporting,
  matrixHistoricalImportEventEmitter
};
