'use strict';

const env = require('gitter-web-env');
const stats = env.stats;
var bayeuxExtension = require('./extension');
var StatusError = require('statuserror');
var presenceService = require('gitter-web-presence');

module.exports = function(server) {
  return bayeuxExtension({
    channel: '/meta/connect',
    name: 'doorman',
    failureStat: 'bayeux.connect.deny',
    skipSuperClient: true,
    skipOnError: true,
    ignoreErrorsInLogging: [
      // We don't care about logging the error details for people who provide wrong info.
      // We still have stats in Datadog to track big changes in these errors.
      'Client does not exist',
      'Socket association does not exist'
    ],
    incoming: function(message, req, callback) {
      var clientId = message.clientId;

      server._server._engine.clientExists(clientId, function(exists) {
        if (!exists) {
          stats.eventHF('bayeux.doorman.client_not_found');
          return callback(new StatusError(401, 'Client does not exist'));
        }

        presenceService.socketExists(clientId, function(err, exists) {
          if (err) return callback(err);

          if (!exists) {
            stats.eventHF('bayeux.doorman.socket_association_not_found');
            return callback(new StatusError(401, 'Socket association does not exist'));
          }

          return callback(null, message);
        });
      });
    }
  });
};
