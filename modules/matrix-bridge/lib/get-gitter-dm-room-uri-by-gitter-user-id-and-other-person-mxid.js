'use strict';

const assert = require('assert');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

function getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid) {
  assert(mongoUtils.isLikeObjectId(gitterUserId));
  assert(otherPersonMxid);

  const gitterRoomUri = `matrix/${gitterUserId}/${otherPersonMxid}`;
  return gitterRoomUri;
}

module.exports = getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid;
