/*jshint unused:true, browser:true*/
define([
  'jquery',
  'faye',
  'utils/log'
], function($, Faye, log) {
  "use strict";

  //Faye.Logging.logLevel = 'info';

  var connected = false;
  var connectionProblemTimeoutHandle;
  var persistentOutage = false;

  function connectionProblemTimeout() {
    connectionProblemTimeoutHandle = null;

    // If there was a timing issue
    if(connected) {
      if(persistentOutage) {
        persistentOutage = false;
        $(document).trigger('realtime:persistentOutageCleared');
      }

      return;
    }

    if(!persistentOutage) {
      persistentOutage = true;
      $(document).trigger('realtime:persistentOutage');
    }
  }

  var ClientAuth = function() {};
  ClientAuth.prototype.outgoing = function(message, callback) {
    if(message.channel == '/meta/handshake') {
      message.ext = message.ext || {};
      message.ext.token = window.troupeContext.accessToken;
    }

    callback(message);
  };

  var c = window.troupeContext.websockets;

  var client = new Faye.Client(c.fayeUrl, c.options);

  if(c.disable) {
    for(var i = 0; i < c.length; i++) {
      client.disable(c.disable[i]);
    }
  }

  client.addExtension(new ClientAuth());

  client.connect(function() {});


  client.bind('transport:down', function() {
    log('transport:down');
    connected = false;

    if(!connectionProblemTimeoutHandle) {
      connectionProblemTimeoutHandle = window.setTimeout(connectionProblemTimeout, 5000);
    }

    // the client is not online
    $(document).trigger('realtime:down');
  });

  client.bind('transport:up', function() {
    log('transport:up');
    connected = true;

    if(connectionProblemTimeoutHandle) {
      window.clearTimeout(connectionProblemTimeoutHandle);
      connectionProblemTimeoutHandle = null;
    }

    // the client is online
    $(document).trigger('realtime:up');

    // Long term outage
    if(persistentOutage) {
      persistentOutage = false;
      $(document).trigger('realtime:persistentOutageCleared');
    }
  });

  // Give the initial load 5 seconds to connect before warning the user that there is a problem
  connectionProblemTimeoutHandle = window.setTimeout(connectionProblemTimeout, 5000);

  if(window.troupeContext && window.troupeContext.troupe) {
    /*var subscription = */ client.subscribe('/troupes/' + window.troupeContext.troupe.id, function(message) {
      log("Subscription!", message);
      if(message.notification === 'presence') {
        if(message.status === 'in') {
          $(document).trigger('userLoggedIntoTroupe', message);
        } else if(message.status === 'out') {
          $(document).trigger('userLoggedOutOfTroupe', message);
        }
      }
      if (message.operation === "update") {
        $(document).trigger('troupeUpdate', message);
      }
    });
  }

  return client;
});