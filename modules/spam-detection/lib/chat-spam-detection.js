'use strict';

const assert = require('assert');
var env = require('gitter-web-env');
var logger = env.logger.get('spam-detection');
var Promise = require('bluebird');
var mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
var duplicateChatDetector = require('./duplicate-chat-detector');
const detectEthereumSpam = require('./detect-ethereum-spam');
const userService = require('gitter-web-users');
var stats = env.stats;
const config = env.config;

var ONE_DAY_TIME = 24 * 60 * 60 * 1000; // One day
var PROBATION_PERIOD = 14 * ONE_DAY_TIME;

/**
 * Super basic spam detection
 */
async function detect({ room, user, parsedMessage }) {
  assert(room);
  assert(user);
  assert(parsedMessage);

  // Once a spammer, always a spammer....
  if (user.hellbanned) return true;

  var userId = user._id;
  var userCreated = mongoUtils.getTimestampFromObjectId(userId);

  // Outside of the probation period? For now, let them do anything
  if (Date.now() - userCreated > PROBATION_PERIOD) {
    return false;
  }

  const spamResults = await Promise.all([
    duplicateChatDetector(userId, parsedMessage.text),
    detectEthereumSpam({
      groupId: room && room.groupId,
      groupIdBlackList: config.get('spam-detection:ethereum-spam-group-id-blacklist'),
      user,
      text: parsedMessage.text
    })
  ]);

  const isSpamming = spamResults.some(result => {
    return result;
  });

  if (isSpamming) {
    logger.warn('Auto spam detector to hellban user for suspicious activity', {
      userId: user._id,
      username: user.username,
      text: parsedMessage.text
    });

    stats.event('auto_hellban_user', {
      userId: user._id
    });

    await userService.hellbanUser(userId);
  }

  return isSpamming;
}

module.exports = {
  detect: Promise.method(detect)
};
