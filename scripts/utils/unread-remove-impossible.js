'use strict';

var redis = require('gitter-web-utils/lib/redis');
var userService = require('gitter-web-users');
var roomService = require('gitter-web-rooms');
var troupeService = require('gitter-web-rooms/lib/troupe-service');
var unreadService = require('gitter-web-unread-items');
var Promise = require('bluebird');
var shutdown = require('shutdown');
var _ = require('lodash');

/** THIS SCRIPT WILL TRASH OUR REDIS ENVIRONMENT */
process.exit();

require('../../server/event-listeners').install();

function getKeys() {
  var redisClient = redis.getClient();

  return Promise.fromCallback(function(callback) {
    return redisClient.keys('unread:chat:*', callback);
  });
}

function convertToHash(unreadKeys) {
  var hash = {};
  unreadKeys.forEach(function(unreadKey) {
    var parts = unreadKey.split(':');
    var userId = parts[2];
    var roomId = parts[3];

    var roomIds = hash[userId] || [];

    roomIds.push(roomId);
    hash[userId] = roomIds;
  });

  return hash;
}

function markAllWeirdRoomsAsReadForUser(userId, roomIds) {
  var promises = roomIds.map(function(roomId) {
    return unreadService.markAllChatsRead(userId, roomId, { member: false, recordAsRead: false });
  });

  return Promise.all(promises);
}

function findAllWeirdRoomIdsForUser(userId, userUnreadRoomIds) {
  return roomService.findAllRoomsIdsForUserIncludingMentions(userId).spread(function(userRoomIds) {
    return _.difference(userUnreadRoomIds, userRoomIds);
  });
}

function logResult(userId, weirdRoomIds) {
  return Promise.all([userService.findById(userId), troupeService.findByIds(weirdRoomIds)]).spread(
    function(user, weirdRooms) {
      var weirdRoomNames = weirdRooms.map(function(room) {
        return room.uri;
      });
      var dbMisses = weirdRoomIds.length - weirdRooms.length;

      var log = [(user && user.username) || '(' + userId + ')', ':']
        .concat(weirdRoomNames)
        .concat('with ' + dbMisses + ' missing rooms')
        .concat(weirdRoomIds)
        .join(' ');

      console.log('cleared', log);
    }
  );
}

function markAllWeirdRoomsAsRead(hash) {
  var promises = Object.keys(hash).map(function(userId) {
    return findAllWeirdRoomIdsForUser(userId, hash[userId]).then(function(weirdRoomIds) {
      if (weirdRoomIds.length) {
        return markAllWeirdRoomsAsReadForUser(userId, weirdRoomIds).then(function() {
          return logResult(userId, weirdRoomIds);
        });
      }
    });
  });

  return Promise.all(promises);
}

getKeys()
  .then(convertToHash)
  .then(markAllWeirdRoomsAsRead)
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
