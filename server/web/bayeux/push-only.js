'use strict';

const env = require('gitter-web-env');
const stats = env.stats;
var bayeuxExtension = require('./extension');
var StatusError = require('statuserror');

module.exports = bayeuxExtension({
  name: 'pushOnly',
  skipSuperClient: true,
  ignoreErrorsInLogging: [
    // We don't care about logging the error details for people who are denied.
    // We still have stats in Datadog to track big changes in these errors.
    'Push access denied'
  ],
  incoming: function(message, req, callback) {
    if (message.channel === '/api/v1/ping2' || message.channel.match(/^\/meta\//)) {
      return callback();
    }

    stats.eventHF('bayeux.push_only.push_access_denied');
    return callback(new StatusError(403, 'Push access denied'));
  }
});
