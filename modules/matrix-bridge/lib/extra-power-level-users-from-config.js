'use strict';

const env = require('gitter-web-env');
const config = env.config;

const extraPowerLevelUserList = config.get('matrix:bridge:extraPowerLevelUserList') || [];
// Workaround the fact that we can't have a direct map from MXID to power levels because
// nconf doesn't like when we put colons (`:`) in keys (see
// https://gitlab.com/gitterHQ/env/-/merge_requests/34). So instead we have  list of
// object entries to re-interprete into a object.
const extraPowerLevelUsers = extraPowerLevelUserList.reduce((accumulatedPowerLevelUsers, entry) => {
  const [key, value] = entry;
  accumulatedPowerLevelUsers[key] = value;
  return accumulatedPowerLevelUsers;
}, {});

module.exports = extraPowerLevelUsers;
