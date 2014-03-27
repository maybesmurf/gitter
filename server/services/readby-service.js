/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var RedisBatcher = require('../utils/redis-batcher').RedisBatcher;
var persistence = require('./persistence-service');
var assert = require('assert');
var batcher = new RedisBatcher('readby', 0);
var winston = require('../utils/winston');
var appEvents = require("../app-events");
var mongoUtils = require('../utils/mongo-utils');
var Q = require('q');

batcher.listen(function(key, userIdStrings, done) {
  var kp = key.split(':', 3);

  // Ignore everything except chats for now
  if(kp[0] !== 'chat') return done();


  var troupeId = mongoUtils.asObjectID(kp[1]);
  var chatId = mongoUtils.asObjectID(kp[2]);

  var userIds = userIdStrings.map(mongoUtils.asObjectID);

  persistence.ChatMessage.findOneAndUpdate(
    { _id: chatId, toTroupeId: troupeId },
    { $addToSet:  { 'readBy': { $each: userIds } } },
    { select: { readBy: 1, _tv: 1 } },
    function(err, chat) {
      if(err) return done(err);

      if(!chat) {
        winston.info('Weird. No chat message found');
      } else {

        appEvents.dataChange2("/troupes/" + troupeId + "/chatMessages", 'patch', {
          id: "" + chatId,
          readBy: chat.readBy.length,
          v: chat._tv ? 0 + chat._tv : undefined
        });

        // Its too operationally expensive to serialise the full user object
        userIds.forEach(function(userId) {
          appEvents.dataChange2("/troupes/" + troupeId + "/chatMessages/" + chatId + '/readBy', 'create', {
            id: userId
          });
        });

      }

      done();
    });

});

/**
 * Record items as having been read
 * @return promise of nothing
 */
exports.recordItemsAsRead = function(userId, troupeId, items, callback) {
  return Q.fcall(function() {
    assert(userId, 'userId expected');
    assert(items, 'items expected');
    if(!items.chat || !items.chat.length) return callback && callback(); // Don't bother with anything other than chats for the moment

    var itemIds = items.chat;
    return Q.all(itemIds.map(function(id) {
      var d = Q.defer();

      assert(mongoUtils.isLikeObjectId(id));
      assert(mongoUtils.isLikeObjectId(userId));
      batcher.add('chat:' + troupeId + ':' + id, userId, d.makeNodeResolver());

      return d.promise;
    }));
  })
  .nodeify(callback);

};
