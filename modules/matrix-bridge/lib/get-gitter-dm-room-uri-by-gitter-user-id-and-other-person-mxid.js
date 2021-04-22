'use strict';

const assert = require('assert');

function getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(gitterUserId, otherPersonMxid) {
  assert(gitterUserId);
  assert(otherPersonMxid);

  const gitterRoomUri = `matrix/${gitterUserId}/${otherPersonMxid}`;
  return gitterRoomUri;
}

module.exports = getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid;
