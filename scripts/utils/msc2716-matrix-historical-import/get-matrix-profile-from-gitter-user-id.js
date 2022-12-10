'use strict';

const LRU = require('lru-cache');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const MatrixUtils = require('gitter-web-matrix-bridge/lib/matrix-utils');

const matrixUtils = new MatrixUtils(matrixBridge);

const gitterUserIdToMatrixProfileCache = LRU({
  max: 2048,
  // 15 minutes
  maxAge: 15 * 60 * 1000
});
async function getMatrixProfileFromGitterUserId(gitterUserId) {
  const serializedGitterUserId = mongoUtils.serializeObjectId(gitterUserId);

  const cachedEntry = gitterUserIdToMatrixProfileCache.get(serializedGitterUserId);
  if (cachedEntry) {
    return cachedEntry;
  }

  const gitterUserMxid = await matrixUtils.getOrCreateMatrixUserByGitterUserId(gitterUserId);

  const intent = matrixBridge.getIntent(gitterUserMxid);
  const currentProfile = await intent.getProfileInfo(gitterUserMxid, null);

  const profileEntry = {
    mxid: gitterUserMxid,
    displayname: currentProfile.displayname,
    avatar_url: currentProfile.avatar_url
  };

  gitterUserIdToMatrixProfileCache.set(serializedGitterUserId, profileEntry);

  return profileEntry;
}

module.exports = getMatrixProfileFromGitterUserId;
