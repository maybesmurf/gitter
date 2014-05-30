/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var express    = require('express');
var nconf      = require('./utils/config');
var winston    = require('./utils/winston');
var bayeux     = require('./web/bayeux');
var appVersion = require('./web/appVersion');
var domainWrapper = require('./utils/domain-wrapper');
var http       = require('http');
var shutdown = require('shutdown');
var serverStats = require('./utils/server-stats');

require('./utils/diagnostics');

winston.info("Starting http/ws service");

var app = express();
var server = http.createServer(domainWrapper(app));

require('./web/graceful-shutdown').install(server, app);

require('./web/express').installSocket(app);

app.get('/', function(req, res) {
  res.send('Nothing to see here. Move along please. ' + appVersion.getAppTag());
});

require('./utils/event-listeners').installLocalEventListeners();

var port = nconf.get('PORT') || nconf.get("ws:port");

bayeux.attach(server);

// Listen to the port
server.listen(port, function() {
  winston.info("Websockets listening on port " + port);
});

serverStats('websockets', server);

shutdown.addHandler('websockets', 10, function(callback) {
  server.close(function() {
    callback();
  });
});


