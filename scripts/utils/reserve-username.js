#!/usr/bin/env node
'use strict';

const userService = require('gitter-web-users');
const shutdown = require('shutdown');

require('../../server/event-listeners').install();

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
  .then(function() {
    var action = opts.unreserve
      ? 'unreserved and people are free to register that username'
      : 'reserved and can no longer be registered';
    console.log(opts.username, 'has been', action);
  })
  // wait 5 seconds to allow for asynchronous `event-listeners` to finish
  // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
  // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
  .then(() => {
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    return new Promise(resolve => setTimeout(resolve, 5000));
  })
  .catch(function(err) {
    console.error(err.stack);
  })
  .finally(function() {
    shutdown.shutdownGracefully();
  });
