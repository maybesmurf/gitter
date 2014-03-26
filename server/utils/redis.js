/*jshint node:true, unused:true */
"use strict";

var Q = require('q');
var nconf = require("./config");
var winston = require("./winston");
var redis = require("redis");
var shutdown = require('./shutdown');
var host = nconf.get("redis:host");
var port = nconf.get("redis:port");
var redisDb = nconf.get("redis:redisDb");
var clients = [];

shutdown.addHandler('redis', 1, function(callback) {
  var promises = [];

  clients.forEach(function(client) {
    var d = Q.defer();
    promises.push(d.promise);

    client.quit(function() {
      d.resolve();
    });
  });

  Q.all(promises).then(function() {
    callback();
  }).fail(function(err) {
    if(err) console.error("Quit failed", err);
    callback(err);
  });
});


exports.createClient = function createClient() {
  var client = redis.createClient(port, host);

  if(redisDb) {
    client.select(redisDb, function(err) {
      if(err) {
        winston.error('Unable to switch redis databases', err);
        throw err;
      }
    });
  }

  client.once('end', function() {
    winston.verbose('Redis client quit, removing from list');

    for(var i = 0; i < clients.length; i++) {
      if(clients[i] === client) {
        clients.splice(i, 1);

        return;
      }
    }
  });

  clients.push(client);

  if(clients.length % 10 === 0) {
    winston.info(clients.length + ' redis clients are currently open');
  }

  return client;
};
