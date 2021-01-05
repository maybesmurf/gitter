#!/usr/bin/env node
'use strict';

const userService = require('gitter-web-users');
const shutdown = require('shutdown');

const opts = require('yargs')
  .option('username', {
    required: true,
    description: 'username to reserve e.g trevorah',
    string: true
  })
  .option('unreserve', {
    alias: 'u',
    type: 'boolean',
    description: 'unreserve usersername'
  })
  .help('help')
  .alias('help', 'h').argv;

Promise.resolve()
  .then(() => {
    if (opts.unreserve) {
      return userService.unreserveUsername(opts.username);
    }

    return userService.reserveUsername(opts.username);
  })
  .then(() => {
    return new Promise(resolve => {
      setTimeout(resolve, 5000);
    });
  })
  .then(function() {
    var action = opts.unreserve
      ? 'unreserved and people are free to register that username'
      : 'reserved and can no longer be registered';
    console.log(opts.username, 'has been', action);
  })
  .catch(function(err) {
    console.error(err.stack);
  })
  .finally(function() {
    shutdown.shutdownGracefully();
  });
