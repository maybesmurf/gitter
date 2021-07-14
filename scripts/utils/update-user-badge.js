#!/usr/bin/env node
/*jslint node:true, unused:true */
'use strict';

var userService = require('gitter-web-users');
var pushNotificationGateway = require('../../server/gateways/push-notification-gateway');
var shutdown = require('shutdown');
var onMongoConnect = require('gitter-web-persistence-utils/lib/on-mongo-connect');
var shimPositionOption = require('../yargs-shim-position-option');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option(
    'username',
    shimPositionOption({
      position: 0,
      required: true,
      description: 'username to send badge update to',
      string: true
    })
  )
  .help('help')
  .alias('help', 'h').argv;

onMongoConnect()
  .then(function() {
    return userService.findByUsername(opts.username);
  })
  .then(function(user) {
    return user._id;
  })
  .then(function(userId) {
    return pushNotificationGateway.sendUsersBadgeUpdates([userId]);
  })
  // wait 5 seconds to allow for asynchronous `event-listeners` to finish
  // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
  // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
  .then(() => {
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    return new Promise(resolve => setTimeout(resolve, 5000));
  })
  .then(function() {
    shutdown.shutdownGracefully();
  })
  .catch(function(err) {
    console.error(err.stack);
    shutdown.shutdownGracefully(1);
  });
