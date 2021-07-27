#!/usr/bin/env node
/*jslint node:true, unused:true */
'use strict';

var _ = require('lodash');
var userService = require('gitter-web-users');
var troupeService = require('gitter-web-rooms/lib/troupe-service');
var chatService = require('gitter-web-chats');
var oneToOneRoomService = require('gitter-web-rooms/lib/one-to-one-room-service');
var loremIpsum = require('lorem-ipsum');

require('../../server/event-listeners').install();
var Promise = require('bluebird');

var shutdown = require('shutdown');

var opts = require('yargs')
  .option('uri', {
    description: 'uri of room to list presence for'
  })
  .option('fromUser', {
    description: 'id of room to list presence for'
  })
  .option('toUser', {
    description: 'id of room to list presence for'
  })
  .option('numberOfMessages', {
    type: 'number',
    description: 'number of messages to send',
    default: 1
  })
  .help('help')
  .alias('help', 'h').argv;

function getTroupe(fromUser) {
  if (opts.uri) {
    return troupeService.findByUri(opts.uri);
  }

  if (!opts.toUser) {
    return Promise.reject(new Error('Please specify either a uri or a fromUser and toUser'));
  }

  return userService.findByUsername(opts.toUser).then(function(toUser) {
    if (!toUser) throw new Error('User ' + opts.toUser + ' not found');

    return oneToOneRoomService.findOneToOneRoom(fromUser._id, toUser._id);
  });
}

userService
  .findByUsername(opts.fromUser)
  .then(function(fromUser) {
    if (!fromUser) throw new Error('User ' + opts.fromUser + ' not found');

    return [fromUser, getTroupe(fromUser)];
  })
  .spread(function(fromUser, troupe) {
    if (!troupe) throw new Error('Room not found');
    return _.range(opts.numberOfMessages).reduce(function(chain, num) {
      return chain.then(function() {
        return chatService.newChatMessageToTroupe(troupe, fromUser, {
          text: 'Test message ' + num + ': ' + loremIpsum({ count: 1 })
        });
      });
    }, Promise.resolve());
  })
  .then(function(result) {
    console.log(result);
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
