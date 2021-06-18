'use strict';

const env = require('gitter-web-env');
const stats = env.stats;
var bayeuxExtension = require('./extension');
var StatusError = require('statuserror');
var presenceService = require('gitter-web-presence');

module.exports = function(server) {
  return bayeuxExtension({
    channel: '/api/v1/ping2',
    name: 'pingResponder',
    failureStat: 'bayeux.ping.deny',
    ignoreErrorsInLogging: [
      // We don't care about logging the error details for people who provide wrong info.
      // We still have stats in Datadog to track big changes in these errors.
      'Client does not exist',
      'Socket association does not exist'
    ],
    incoming: function(message, req, callback) {
      // Remember we've got the ping reason if we need it
      //var reason = message.data && message.data.reason;

      var clientId = message.clientId;

      server._server._engine.clientExists(clientId, function(exists) {
        if (!exists) {
          stats.eventHF('bayeux.ping_responder.client_not_found');
          return callback(new StatusError(401, 'Client does not exist'));
        }

        presenceService.socketExists(clientId, function(err, exists) {
          if (err) return callback(err);

          if (!exists) {
            stats.eventHF('bayeux.ping_responder.socket_association_not_found');
            return callback(new StatusError(401, 'Socket association does not exist'));
          }

          return callback(null, message);
        });
      });
    }
  });
};
