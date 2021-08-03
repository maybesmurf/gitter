#!/usr/bin/env node
'use strict';

var shutdown = require('shutdown');
var userService = require('gitter-web-users');
var StatusError = require('statuserror');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option('username', {
    alias: 'u',
    required: true,
    description: 'Username to add staff status',
    string: true
  })
  .option('remove', {
    alias: 'r',
    description: 'Whether to remove staff status',
    type: 'boolean'
  })
  .help('help')
  .alias('help', 'h').argv;

userService
  .findByUsername(opts.username)
  .then(function(user) {
    if (!user) {
      console.log('not found');
      throw new StatusError(404, 'user not found');
    }

    var staffStatus = !opts.remove;
    user.staff = staffStatus;
    return user.save().then(function() {
      return staffStatus;
    });
  })
  .then(function(staffStatus) {
    console.log(opts.username + ' staff status:', staffStatus);
    console.log('done');
  })
  // wait 5 seconds to allow for asynchronous `event-listeners` to finish
  // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
  // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
  .then(() => {
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    return new Promise(resolve => setTimeout(resolve, 5000));
  })
  .finally(function() {
    shutdown.shutdownGracefully();
  });
