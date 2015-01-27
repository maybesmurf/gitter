/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var env              = require('../utils/env');
var logger           = env.logger;
var engine           = require('./unread-item-service-engine');
var troupeService    = require("./troupe-service");
var readByService    = require("./readby-service");
var userService      = require("./user-service");
var roomPermissionsModel = require('./room-permissions-model');
var appEvents        = require("../app-events");
var _                = require("underscore");
var mongoUtils       = require('../utils/mongo-utils');
var RedisBatcher     = require('../utils/redis-batcher').RedisBatcher;
var Q                = require('q');
var badgeBatcher     = new RedisBatcher('badge', 300);

engine.on('badge.update', function(userId) {
  badgeBatcher.add('queue', userId);
});

function sinceFilter(since) {
  return function(id) {
    var date = mongoUtils.getDateFromObjectId(id);
    return date.getTime() >= since;
  };

}

badgeBatcher.listen(function(key, userIds, done) {
  // Remove duplicates
  userIds = _.uniq(userIds);

  // Get responders to respond
  appEvents.batchUserBadgeCountUpdate({
    userIds: userIds
  });

  done();
});

function reject(msg) {
  logger.error(msg);
  return Q.reject(new Error(msg));
}

/**
 * Item removed
 * @return {promise} promise of nothing
 */
function removeItem(troupeId, itemId) {
  if(!troupeId) return reject("newitem failed. Troupe cannot be null");
  if(!itemId) return reject("newitem failed. itemId cannot be null");

  return troupeService.findUserIdsForTroupeWithLurk(troupeId)
    .then(function(troupe) {
      var userIdsWithLurk = troupe.users;
      var userIds = Object.keys(userIdsWithLurk);

      // Publish out an unread item removed event
      // TODO: we could actually check whether this user thinks this item is UNREAD
      var data = { chat: [itemId] };

      userIds.forEach(function(userId) {
        appEvents.unreadItemsRemoved(userId, troupeId, data);
      });

      var userIdsForNotify = userIds.filter(function(u) {
        return !userIdsWithLurk[u];
      });

      return engine.removeItem(troupeId, itemId, userIdsForNotify)
        .then(function(removeResults) {
          removeResults.forEach(function(removeResult) {

            if(removeResult.unreadCount >= 0 || removeResult.mentionCount >= 0) {
              appEvents.troupeUnreadCountsChange({
                userId: removeResult.userId,
                troupeId: troupeId,
                total: removeResult.unreadCount,
                mentions: removeResult.mentionCount
              });
            }

          });

        });

  });
}

/*
  This ensures that if all else fails, we clear out the unread items
  It should only have any effect when data is inconsistent
*/
function ensureAllItemsRead(userId, troupeId) {
  if(!userId) return reject("ensureAllItemsRead failed. userId required");
  if(!troupeId) return reject("ensureAllItemsRead failed. troupeId required");

  return engine.ensureAllItemsRead(userId, troupeId)
    .then(function() {

      // Notify the user
      appEvents.troupeUnreadCountsChange({
        userId: userId,
        troupeId: troupeId,
        total: 0,
        mentions: 0
      });

    });
}

/**
 * Returns a hash of hash {user:troupe:ids} of users who have
 * outstanding notifications since before the specified time
 * @return a promise of hash
 */
exports.listTroupeUsersForEmailNotifications = function(horizonTime, emailLatchExpiryTimeS) {
  return engine.listTroupeUsersForEmailNotifications(horizonTime, emailLatchExpiryTimeS);
};

/**
 * Mark many items as read, for a single user and troupe
 */
exports.markItemsRead = function(userId, troupeId, itemIds, options) {
  if(!userId) return reject("userId required");
  if(!troupeId) return reject("troupeId required");

  var markAllRead = options && options.markAllRead;

  if(!markAllRead) {
    // No need to send individual notifications on markAllRead
    appEvents.unreadItemsRemoved(userId, troupeId, { chat: itemIds });
  }

  return engine.markItemsRead(userId, troupeId, itemIds)
    .then(function(result) {
      if(result.unreadCount >= 0 || result.mentionCount >= 0) {
        // Notify the user
        appEvents.troupeUnreadCountsChange({
          userId: userId,
          troupeId: troupeId,
          total: result.unreadCount,
          mentions: result.mentionCount
        });
      }

      var recordAsRead = !options || options.recordAsRead === undefined ? true : options.recordAsRead;

      if(recordAsRead) {
        return readByService.recordItemsAsRead(userId, troupeId, { chat: itemIds });
      }

    });

};

exports.markAllChatsRead = function(userId, troupeId, options) {
  if(!mongoUtils.isLikeObjectId(userId)) return reject('userId must be a mongoid');
  if(!mongoUtils.isLikeObjectId(troupeId)) return reject('troupeId must be a mongoid');

  if(!options) options = {};
  appEvents.markAllRead({ userId: userId, troupeId: troupeId });

  return exports.getUnreadItems(userId, troupeId, 'chat')
    .then(function(chatIds) {
      /* If we already have everything marked as read, force all read */
      if(!chatIds.length) return ensureAllItemsRead(userId, troupeId, options);

      if(!('recordAsRead' in options)) options.recordAsRead = false;

      options.markAllRead = true; // Don't send individual item read events

      /* Don't mark the items as read */
      return exports.markItemsRead(userId, troupeId, chatIds, options);
    });
};

exports.getUserUnreadCounts = function(userId, troupeId) {
  return engine.getUserUnreadCounts(userId, troupeId);
};

exports.getUserUnreadCountsForTroupeIds = function(userId, troupeIds) {
  return engine.getUserUnreadCountsForRooms(userId, troupeIds);
};

exports.getUserMentionCountsForTroupeIds = function(userId, troupeIds) {
  return engine.getUserMentionCountsForRooms(userId, troupeIds);
};

exports.getUserMentionCounts = function(userId) {
  return engine.getUserMentionCounts(userId);
};

exports.getUnreadItems = function(userId, troupeId) {
  return engine.getUnreadItems(userId, troupeId);
};

exports.getAllUnreadItemCounts = function(userId) {
  return engine.getAllUnreadItemCounts(userId);
};

exports.getRoomIdsMentioningUser = function(userId) {
  return engine.getRoomsMentioningUser(userId);
};

exports.getUnreadItemsForUserTroupeSince = function(userId, troupeId, since, callback) {
  return engine.getUnreadItems(userId, troupeId)
    .then(function(chatItems) {
      chatItems = chatItems.filter(sinceFilter(since));

      var response = {};
      if(chatItems.length) {
        response.chat = chatItems;
      }

      return response;
    })
    .nodeify(callback);
};

exports.getFirstUnreadItem = function(userId, troupeId) {
  return engine.getUnreadItems(userId, troupeId)
    .then(function(members) {
      return getOldestId(members);
    })
    .catch(function(err) {
      logger.warn("unreadItemService.getUnreadItems failed: " + err, { exception: err });
      return null;
    });
};

exports.getUnreadItemsForUser = function(userId, troupeId, callback) {
  return exports.getUnreadItems(userId, troupeId)
    .then(function(results) {
      return {
        chat: results
      };
    })
    .nodeify(callback);
};

/**
 * Get the badge counts for userIds
 * @return promise of a hash { userId1: 1, userId: 2, etc }
 */
exports.getBadgeCountsForUserIds = function(userIds, callback) {
  return engine.getBadgeCountsForUserIds(userIds)
    .nodeify(callback);
};

function getOldestId(ids) {
  if(!ids.length) return null;

  return _.min(ids, function(id) {
    // Create a new ObjectID with a specific timestamp
    return mongoUtils.getTimestampFromObjectId(id);
  });
}

function getTroupeIdsCausingBadgeCount(userId) {
  return engine.getRoomsCausingBadgeCount(userId);
}

function parseMentions(fromUserId, troupe, mentions) {
  var creatorUserId = fromUserId && "" + fromUserId;

  var usersHash = troupe.users.reduce(function(memo, troupeUser) {
    memo[troupeUser.userId] = 1;
    return memo;
  }, {});

  var uniqueUserIds = {};
  mentions.forEach(function(mention) {
    if(mention.group) {
      if(mention.userIds) {
        mention.userIds.forEach(function(userId) {
          uniqueUserIds[userId] = true;
        });
      }
    } else {
      if(mention.userId) {
        uniqueUserIds[mention.userId] = true;
      }
    }
  });

  var memberUserIds = [];
  var nonMemberUserIds = [];
  var lookupUsers = [];

  Object.keys(uniqueUserIds).forEach(function(userId) {
    /* Don't be mentioning yourself yo */
    if(userId == creatorUserId) return;

    if(usersHash[userId]) {
      memberUserIds.push(userId);
      return;
    }

    lookupUsers.push(userId);
  });

  if(!lookupUsers.length) {
    return Q.resolve({
      memberUserIds: memberUserIds,
      nonMemberUserIds: [],
      mentionUserIds: memberUserIds
    });
  }

  /* Lookup the non-members and check if they can access the room */
  return userService.findByIds(lookupUsers)
    .then(function(users) {
      /* TODO: do something about users not on gitter here */
      return Q.all(users.map(function(user) {
        /* TODO: some sort of bulk service here */
        return roomPermissionsModel(user, 'join', troupe)
          .then(function(access) {
            if(access) {
              nonMemberUserIds.push("" + user.id);
            }
          });
      }));
    })
    .then(function() {
      /* Mentions consists of members and non-members */
      var mentionUserIds = memberUserIds.concat(nonMemberUserIds);

      return {
        memberUserIds: memberUserIds,
        nonMemberUserIds: nonMemberUserIds,
        mentionUserIds: mentionUserIds
      };
    });
}

function parseChat(fromUserId, troupe, mentions) {
  var creatorUserId = fromUserId && "" + fromUserId;

  var nonActive = [];
  var active = [];

  troupe.users.forEach(function(troupeUser) {
    var userId = troupeUser.userId;

    if (creatorUserId && ("" + userId) === creatorUserId) return;

    if (troupeUser.lurk) {
      nonActive.push(userId);
    } else {
      active.push(userId);
    }

  });

  if(!mentions || !mentions.length) {
    return Q.resolve({
      notifyUserIds: active,
      mentionUserIds: [],
      activityOnlyUserIds: nonActive,
      notifyNewRoomUserIds: []
    });
  }

  /* Add the mentions into the mix */
  return parseMentions(fromUserId, troupe, mentions)
    .then(function(parsedMentions) {
      var notifyUserIdsHash = {};
      active.forEach(function(userId) { notifyUserIdsHash[userId] = 1; });
      parsedMentions.mentionUserIds.forEach(function(userId) { notifyUserIdsHash[userId] = 1; });

      var nonActiveLessMentions = nonActive.filter(function(userId) {
        return !notifyUserIdsHash[userId];
      });

      return {
        notifyUserIds: Object.keys(notifyUserIdsHash),
        mentionUserIds: parsedMentions.mentionUserIds,
        activityOnlyUserIds: nonActiveLessMentions,
        notifyNewRoomUserIds: parsedMentions.nonMemberUserIds
      };
    });
}

function createNewItemsForParsedChat(troupeId, chatId, parsed) {
  return engine.newItemWithMentions(troupeId, chatId, parsed.notifyUserIds, parsed.mentionUserIds)
    .then(function(results) {

      // Firstly, notify all the notifyNewRoomUserIds with room creation messages
      parsed.notifyNewRoomUserIds.forEach(function(userId) {
        appEvents.userMentionedInNonMemberRoom({ troupeId: troupeId, userId: userId });
      });

      // Next, notify all the users with unread count changes
      parsed.notifyUserIds.forEach(function(userId) {
        var unreadCount = results[userId] && results[userId].unreadCount;
        var mentionCount = results[userId] && results[userId].mentionCount;

        // Not lurking, send them the full update
        appEvents.newUnreadItem(userId, troupeId, { chat: [chatId] });

        if(unreadCount >= 0 || mentionCount >= 0) {
          // Notify the user
          appEvents.troupeUnreadCountsChange({
            userId: userId,
            troupeId: troupeId,
            total: unreadCount,
            mentions: mentionCount
          });
        }
      });

      // Next, notify all the lurkers
      parsed.activityOnlyUserIds.forEach(function(userId) {
        appEvents.newLurkActivity({ userId: userId, troupeId: troupeId });
      });

    });
}

function createChatUnreadItems(fromUserId, troupe, chat) {
  return parseChat(fromUserId, troupe, chat.mentions)
    .then(function(parsed) {
      return createNewItemsForParsedChat(troupe.id, chat.id, parsed);
    });
}
exports.createChatUnreadItems = createChatUnreadItems;

function updateChatUnreadItems(fromUserId, troupe, chat, originalMentions) {
  var troupeId = troupe.id;

  var originalMentionUserIds = originalMentions
    .map(function(mention) {
      if(mention.userIds.length) return mention.userIds;
      return mention.userId;
    })
    .filter(function(m) {
      return !!m;
    });

  /* Arg. Underscore. We need lazy evaluation! */
  originalMentionUserIds = _.flatten(originalMentionUserIds);
  originalMentionUserIds = _.uniq(originalMentionUserIds);

  return parseChat(fromUserId, troupe, chat.mentions)
    .then(function(parsed) {
      /* No mentions in the original message? Skip the removal */
      if(!originalMentionUserIds.length) return parsed;

      var removeUserIds = _.union(parsed.notifyUserIds, originalMentionUserIds);
      return engine.removeItem(troupeId, chat.id, removeUserIds)
        .then(function(results) {

          results.forEach(function(result) {
            if(result.unreadCount >= 0 || result.mentionCount >= 0) {
              // Notify the user
              appEvents.troupeUnreadCountsChange({
                userId: result.userId,
                troupeId: troupeId,
                total: result.unreadCount,
                mentions: result.mentionCount
              });
            }
          });

          return parsed;
        });
    })
    .then(function(parsed) {
      return createNewItemsForParsedChat(troupeId, chat.id, parsed);
    });
}
exports.updateChatUnreadItems = updateChatUnreadItems;

exports.testOnly = {
  getOldestId: getOldestId,
  sinceFilter: sinceFilter,
  removeItem: removeItem,
  getTroupeIdsCausingBadgeCount: getTroupeIdsCausingBadgeCount,
  parseChat: parseChat
};
