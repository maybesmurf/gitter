'use strict';

const BRIDGE_USER_POWER_LEVEL = 100;

// The highest power level is 90 so we can set Gitter room admins at 90 and they
// can do everything but we can still keep the gitter-badger bridge user at 100.
// This way the badger can still remove admins that we set (greater power level
// than the Gitter room admins).
const ROOM_ADMIN_POWER_LEVEL = 90;

module.exports = {
  BRIDGE_USER_POWER_LEVEL,
  ROOM_ADMIN_POWER_LEVEL
};
