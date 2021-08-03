#!/usr/bin/env node
/*jslint node: true */
'use strict';

var userService = require('gitter-web-users');
var shutdown = require('shutdown');
var shimPositionOption = require('../yargs-shim-position-option');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option(
    'username',
    shimPositionOption({
      position: 0,
      required: true,
      description: 'username to hellban e.g trevorah',
      string: true
    })
  )
  .option('unban', {
    alias: 'u',
    type: 'boolean',
    description: 'unban user from hell'
  })
  .help('help')
  .alias('help', 'h').argv;

console.log(opts);

userService
  .findByUsername(opts.username)
  .then(function(user) {
    if (!user) {
      throw new Error(`User does not exist: ${opts.username}`);
    }

    if (opts.unban) {
      return userService.unhellbanUser(user.id);
    }

    return userService.hellbanUser(user.id);
  })
  .then(function() {
    var action = opts.unban
      ? 'redeemed to walk amongst us again'
      : 'banned to a special kind of hell';
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
