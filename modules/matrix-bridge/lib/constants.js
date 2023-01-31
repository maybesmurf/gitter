'use strict';

const assert = require('assert');

const BRIDGE_USER_POWER_LEVEL = 100;

// The highest power level to do any action in the room is set at `90` so we can set
// Gitter room admins at 90 and they can do everything but we can still keep the
// gitter-badger bridge user at 100. This way the badger can still add/remove admins as
// necesssary.
const ROOM_ADMIN_POWER_LEVEL = 90;

assert(
  BRIDGE_USER_POWER_LEVEL > ROOM_ADMIN_POWER_LEVEL,
  `BRIDGE_USER_POWER_LEVEL=${BRIDGE_USER_POWER_LEVEL} should be greater than ROOM_ADMIN_POWER_LEVEL=${ROOM_ADMIN_POWER_LEVEL} to ensure the bridge can add/remove admins as necessary`
);

module.exports = {
  BRIDGE_USER_POWER_LEVEL,
  ROOM_ADMIN_POWER_LEVEL
};
