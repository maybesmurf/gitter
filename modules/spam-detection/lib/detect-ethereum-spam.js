'use strict';

const assert = require('assert');
const Promise = require('bluebird');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const identityService = require('gitter-web-identity');

// Super basic ethereum spam detection
// - `Send 3ETH 0x31999626cDc00c877530b64c209707Ad0ED556fE`
// - `sent 5 ETH 0x519040d1Daa5Ab78b9C87F825A38b5464Cd3828d`
const ETH_SPAM_RE = /sen[dt]\s+\d+(\s+)?eth\s+0x[0-9a-f]+/i;

function detectTwitterUser(user) {
  return identityService
    .getIdentityForUser(user, identityService.TWITTER_IDENTITY_PROVIDER)
    .then(twitterIdentity => {
      return !!twitterIdentity;
    });
}

function detectBadGroup(targetGroupId, groupIdBlackList = []) {
  if (!targetGroupId) {
    return false;
  }

  return groupIdBlackList.some(groupId => {
    return mongoUtils.objectIDsEqual(groupId, targetGroupId);
  });
}

function detect({ groupId, groupIdBlackList = [], user, text }) {
  assert(user);
  assert(text);

  return Promise.props({
    isTwitterUser: detectTwitterUser(user),
    isBadGroup: detectBadGroup(groupId, groupIdBlackList)
  }).then(({ isTwitterUser, isBadGroup }) => {
    if (!isTwitterUser || !isBadGroup) {
      return false;
    }

    return ETH_SPAM_RE.test(text);
  });
}

module.exports = detect;
