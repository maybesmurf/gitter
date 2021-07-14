#!/usr/bin/env node
/*jslint node: true, unused:true */
'use strict';

var shutdown = require('shutdown');
var roomService = require('gitter-web-rooms');
var troupeService = require('gitter-web-rooms/lib/troupe-service');
var Promise = require('bluebird');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option('uri', {
    alias: 'u',
    required: true,
    description: 'Uri of the room to delete'
  })
  .help('help')
  .alias('help', 'h').argv;

var readline = require('readline');

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

troupeService
  .findByUri(opts.uri)
  .then(function(room) {
    return new Promise(function(resolve, reject) {
      rl.question(
        'Are you sure you want to delete ' +
          room.uri +
          ' with ' +
          room.userCount +
          ' users in it? (yes/no)',
        function(answer) {
          rl.close();
          console.log(answer);

          if (answer === 'yes') {
            resolve(room);
          } else {
            reject(new Error('Answered no'));
          }
        }
      );
    });
  })
  .then(function(room) {
    return roomService.deleteRoom(room);
  })
  .then(function() {
    console.log('DONE. finishing up.');
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
    console.error('Error: ' + err, err);
    console.log(err.stack);
    shutdown.shutdownGracefully(1);
  })
  .done();
