'use strict';

const assert = require('assert');
const env = require('gitter-web-env');
const logger = env.logger.get('spam-detection');
const Promise = require('bluebird');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const duplicateChatDetector = require('./duplicate-chat-detector');
const detectEthereumSpam = require('./detect-ethereum-spam');
const userService = require('gitter-web-users');
const chatService = require('gitter-web-chats');
const stats = env.stats;
const config = env.config;

const ETHEREUM_DIRTY_GROUP_LIST = config.get('spam-detection:ethereum-dirty-group-list');

const ONE_DAY_TIME = 24 * 60 * 60 * 1000; // One day
const PROBATION_PERIOD = 14 * ONE_DAY_TIME;

/**
 * Super basic spam detection
 */
async function detect({ room, user, parsedMessage }) {
  assert(room);
  assert(user);
  assert(parsedMessage);

  // Once a spammer, always a spammer....
  if (user.hellbanned) return true;

  const roomId = room.id || room._id;
  const userId = user.id || user._id;
  const userCreated = mongoUtils.getTimestampFromObjectId(userId);

  // Outside of the probation period? For now, let them do anything
  if (Date.now() - userCreated > PROBATION_PERIOD) {
    return false;
  }

  const spamResults = await Promise.all([
    duplicateChatDetector(userId, parsedMessage.text),
    detectEthereumSpam({
      groupId: room && room.groupId,
      dirtyGroupList: ETHEREUM_DIRTY_GROUP_LIST,
      user,
      text: parsedMessage.text
    })
  ]);

  const [isBulkSpammer, isEthereumSpammer] = spamResults;

  if (isBulkSpammer) {
    stats.event('spam_detection.bulk_spam_detected', {
      userId: userId
    });
  }

  if (isEthereumSpammer) {
    stats.event('spam_detection.ethereum_spam_detected', {
      userId: userId
    });

    // Clean up all of their messages in the room
    // as it is probably just them begging for Ethereum in different ways
    await chatService.removeAllMessagesForUserIdInRoomId(userId, roomId);
  }

  const isSpamming = spamResults.some(result => {
    return result;
  });

  if (isSpamming) {
    logger.warn('Auto spam detector to hellban user for suspicious activity', {
      userId,
      username: user.username,
      text: parsedMessage.text
    });

    stats.event('auto_hellban_user', {
      userId: userId
    });

    await userService.hellbanUser(userId);
  }

  return isSpamming;
}

module.exports = {
  detect: Promise.method(detect)
};
