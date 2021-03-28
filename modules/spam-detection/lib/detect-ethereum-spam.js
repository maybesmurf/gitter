'use strict';

const assert = require('assert');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

// Super basic Ethereum spam detection
// - `0x31999626cDc00c877530b64c209707Ad0ED556fE`
// - `0x519040d1Daa5Ab78b9C87F825A38b5464Cd3828d`
const ETH_SPAM_RE = /^0x[0-9a-f]{40}$/i;

function detectDirtyGroup(targetGroupId, dirtyGroupList = []) {
  if (!targetGroupId) {
    return false;
  }

  return dirtyGroupList.some(groupId => {
    return mongoUtils.objectIDsEqual(groupId, targetGroupId);
  });
}

async function detect({
  groupId,
  // List of groups that we should clean Ethereum spam in
  dirtyGroupList = [],
  user,
  text
}) {
  assert(user);
  assert(text);

  if (!dirtyGroupList || dirtyGroupList.length === 0) {
    return false;
  }

  const isDirtyGroup = await detectDirtyGroup(groupId, dirtyGroupList);

  if (!isDirtyGroup) {
    return false;
  }

  return ETH_SPAM_RE.test(text);
}

module.exports = detect;
