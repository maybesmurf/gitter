'use strict';

const debug = require('debug')('gitter:app:chat-reports');
const Promise = require('bluebird');
const env = require('gitter-web-env');
const stats = env.stats;
const logger = env.logger.get('chat-report-service');
const StatusError = require('statuserror');
const ObjectID = require('mongodb').ObjectID;
const mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const ChatMessage = require('gitter-web-persistence').ChatMessage;
const ChatMessageReport = require('gitter-web-persistence').ChatMessageReport;
const chatService = require('gitter-web-chats');
const userService = require('gitter-web-users');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const calculateReportWeight = require('./lib/calculate-report-weight').calculateReportWeight;
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const matrixStore = require('gitter-web-matrix-bridge/lib/store');

const BAD_USER_THRESHOLD = 5;
const BAD_MESSAGE_THRESHOLD = 2;
const ONE_DAY_TIME = 24 * 60 * 60 * 1000; // One day
const SUM_PERIOD = 5 * ONE_DAY_TIME;
const NEW_USER_CLEAR_MESSAGE_PERIOD = 3 * ONE_DAY_TIME;

function sentBefore(objectId) {
  return new Date(objectId.getTimestamp().valueOf() + 1000);
}

function sentAfter(objectId) {
  return new Date(objectId.getTimestamp().valueOf() - 1000);
}

function getReportSumForUser(userInQuestionId, virtualUserInQuestion) {
  const reportQuery = {
    messageUserId: userInQuestionId
  };
  // Make sure we only select messages from the virtualUser or normal user.
  // If someone reports `matrixbot` we want to make sure we don't also count
  // all of the reports against virtualUser.
  if (virtualUserInQuestion) {
    reportQuery['messageVirtualUser.type'] = virtualUserInQuestion.type;
    reportQuery['messageVirtualUser.externalId'] = virtualUserInQuestion.externalId;
  } else {
    reportQuery.messageVirtualUser = { $exists: false };
  }

  return ChatMessageReport.find(reportQuery)
    .lean()
    .exec()
    .then(function(reports) {
      debug('reports', reports, 'reportQuery', reportQuery);
      const resultantReportMap = reports.reduce(function(reportMap, report) {
        const reportSent = report.sent ? report.sent.valueOf() : Date.now();
        const reportWithinRange = Date.now() - reportSent <= SUM_PERIOD;
        // Only count the biggest report from a given user against another
        const isBiggerWeight =
          !reportMap[report.reporterUserId] || report.weight > reportMap[report.reporterUserId];

        if (reportWithinRange && isBiggerWeight) {
          reportMap[report.reporterUserId] = report.weight || 0;
        }

        return reportMap;
      }, {});

      return Object.keys(resultantReportMap).reduce(function(sum, reporterUserIdKey) {
        return sum + resultantReportMap[reporterUserIdKey];
      }, 0);
    });
}

function getReportSumForMessage(messageId) {
  return ChatMessageReport.find({ messageId: messageId })
    .lean()
    .exec()
    .then(function(reports) {
      return reports.reduce(function(sum, report) {
        const reportSent = report.sent ? report.sent.valueOf() : Date.now();
        const reportWithinRange = Date.now() - reportSent <= SUM_PERIOD;

        return sum + (reportWithinRange ? report.weight : 0);
      }, 0);
    });
}

async function newReport(reporterUser, messageId) {
  const reporterUserId = reporterUser._id || reporterUser.id;
  const chatMessage = await chatService.findById(messageId);

  if (!chatMessage) {
    throw new StatusError(404, `Chat message not found (${messageId})`);
  } else if (mongoUtils.objectIDsEqual(reporterUserId, chatMessage.fromUserId)) {
    throw new StatusError(403, "You can't report your own message");
  }

  const room = await troupeService.findByIdLean(chatMessage.toTroupeId);

  if (!room) {
    throw new StatusError(404, `Room not found (${chatMessage.toTroupeId})`);
  }

  const weight = await calculateReportWeight(reporterUser, room, chatMessage);

  const [report, updateExisting] = await mongooseUtils.upsert(
    ChatMessageReport,
    { reporterUserId: reporterUserId, messageId: messageId },
    {
      $setOnInsert: {
        sent: new Date(),
        weight: weight,
        reporterUserId: reporterUserId,
        messageId: messageId,
        messageUserId: chatMessage.fromUserId,
        messageVirtualUser: chatMessage.virtualUser
          ? {
              type: chatMessage.virtualUser.type,
              externalId: chatMessage.virtualUser.externalId
            }
          : undefined,
        text: chatMessage.text
      }
    }
  );

  let checkUserPromise = Promise.resolve();
  let checkMessagePromise = Promise.resolve();

  if (!updateExisting) {
    const userThreshold = BAD_USER_THRESHOLD;

    // Send a stat for a new report
    stats.event('new_chat_message_report', {
      sent: report.sent,
      weight: report.weight,
      reporterUserId: report.reporterUserId,
      messageId: report.messageId,
      messageUserId: report.messageUserId,
      messageVirtualUser: report.messageVirtualUser,
      text: report.text
    });

    checkUserPromise = getReportSumForUser(report.messageUserId, report.messageVirtualUser).then(
      async sum => {
        logger.info(
          `Report from ${report.reporterUserId} with weight=${report.weight} made against user ${report.messageUserId} (messageVirtualUser=${report.messageVirtualUser}), sum=${sum}/${userThreshold}`
        );

        if (sum >= userThreshold) {
          stats.event('new_bad_user_from_reports', {
            userId: report.messageUserId,
            sum: sum
          });

          // Only clear messages for new users (spammers)
          let shouldClearMessages = false;
          if (report.messageVirtualUser) {
            const firstMessage = await ChatMessage.findOne({
              'virtualUser.type': report.messageVirtualUser.type,
              'virtualUser.externalId': report.messageVirtualUser.externalId
            }).exec();

            const firstMessageSentOnGitterTimestamp = new Date(firstMessage.sent).getTime();
            shouldClearMessages =
              Date.now() - firstMessageSentOnGitterTimestamp < NEW_USER_CLEAR_MESSAGE_PERIOD;
          } else {
            const userCreated = mongoUtils.getTimestampFromObjectId(report.messageUserId);
            shouldClearMessages = Date.now() - userCreated < NEW_USER_CLEAR_MESSAGE_PERIOD;
          }

          logger.info(
            `Bad user ${report.messageUserId} detected (hellban${
              shouldClearMessages ? ' and removing all messages' : ''
            }), sum=${sum}/${userThreshold}`
          );

          // Handle banning virtualUsers
          if (report.messageVirtualUser) {
            const matrixRoomId = await matrixStore.getMatrixRoomIdByGitterRoomId(
              chatMessage.toTroupeId
            );

            if (!matrixRoomId) {
              throw new StatusError(
                404,
                `Bridged Matrix room not found for gitterRoomId=${chatMessage.toTroupeId}`
              );
            }

            const bridgeIntent = matrixBridge.getIntent();
            await bridgeIntent.ban(
              matrixRoomId,
              report.messageVirtualUser.externalId,
              'Reported on Gitter'
            );

            if (shouldClearMessages) {
              await chatService.removeAllMessagesForVirtualUser(report.messageVirtualUser);
            }
          }
          // Handle banning normal Gitter users
          else {
            await userService.hellbanUser(report.messageUserId);
            if (shouldClearMessages) {
              await chatService.removeAllMessagesForUserId(report.messageUserId);
            }
          }
        }

        return null;
      }
    );

    checkMessagePromise = getReportSumForMessage(report.messageId).then(async sum => {
      logger.info(
        `Report from ${report.reporterUserId} with weight=${report.weight} made against message ${report.messageId}, sum is now, sum=${sum}/${BAD_MESSAGE_THRESHOLD}`
      );

      if (sum >= BAD_MESSAGE_THRESHOLD) {
        stats.event('new_bad_message_from_reports', {
          messageId: report.messageId,
          sum: sum
        });

        logger.info(
          `Bad message ${report.messageId} detected (removing) sum=${sum}/${BAD_MESSAGE_THRESHOLD}`
        );
        await chatService.deleteMessageFromRoom(room, chatMessage);
      }

      return null;
    });
  }

  await Promise.all([checkUserPromise, checkMessagePromise]);

  return report;
}

function findByIds(ids) {
  return mongooseUtils.findByIds(ChatMessageReport, ids);
}

function findChatMessageReports(options) {
  const limit = Math.min(options.limit || 50, 100);

  let query = ChatMessageReport.find();

  if (options.beforeId) {
    const beforeId = new ObjectID(options.beforeId);
    query = query.where('sent').lte(sentBefore(beforeId));
    query = query.where('_id').lt(beforeId);
  }

  if (options.afterId) {
    const afterId = new ObjectID(options.afterId);
    query = query.where('sent').gte(sentAfter(afterId));
    query = query.where('_id').gt(afterId);
  }

  if (options.lean) {
    query = query.lean();
  }

  return query
    .sort({ sent: 'desc' })
    .limit(limit)
    .exec();
}

module.exports = {
  BAD_USER_THRESHOLD: BAD_USER_THRESHOLD,
  BAD_MESSAGE_THRESHOLD: BAD_MESSAGE_THRESHOLD,
  getReportSumForUser: getReportSumForUser,
  getReportSumForMessage: getReportSumForMessage,
  newReport: newReport,
  findByIds: findByIds,
  findChatMessageReports: findChatMessageReports
};
