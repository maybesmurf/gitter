'use strict';

var env = require('gitter-web-env');
var logger = env.logger;
var _ = require('lodash');
var unreadItemService = require('gitter-web-unread-items');
var getVersion = require('gitter-web-serialization/lib/get-model-version');
var UserIdStrategy = require('./user-id-strategy');
const TroupeIdStrategy = require('./troupe-id-strategy');
var mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
var Promise = require('bluebird');
const {
  getMockIdFromVirtualUser,
  transformVirtualUserIntoMockedFromUser
} = require('gitter-web-users/lib/virtual-user-service');
const generateProxyUrl = require('gitter-web-text-processor/lib/generate-proxy-url');

function formatDate(d) {
  return d ? d.toISOString() : null;
}

function UnreadItemStrategy(options) {
  var unreadItemsHash;

  this.preload = function() {
    return unreadItemService.getUnreadItems(options.userId, options.roomId).then(function(ids) {
      var hash = {};

      _.each(ids, function(id) {
        hash[id] = true;
      });

      unreadItemsHash = hash;
    });
  };

  this.map = function(id) {
    return !!unreadItemsHash[id];
  };
}

UnreadItemStrategy.prototype = {
  name: 'UnreadItemStrategy'
};

/**
 * Serializes chat into JSON
 * - if there is no `currentUserId`, all the messages are going to have default {unread: false}
 */
function ChatStrategy({
  lookups,
  lean,
  user,
  currentUserId,
  serializeFromUserId = true,
  serializeToTroupeId = false,
  troupeId,
  initialId
} = {}) {
  // useLookups will be set to true if there are any lookups that this strategy
  // understands. Currently it only knows about user lookups.
  var useLookups = false;
  var userLookups;
  if (lookups && lookups.indexOf('user') !== -1) {
    useLookups = true;
    userLookups = {};
  }

  if (useLookups) {
    if (lean) {
      // we're breaking users out, but then not returning their displayNames
      // which kinda defeats the purpose
      logger.warn('ChatStrategy was called with lookups, but also with lean', { lookups, lean });
    }
  }

  var userStrategy, troupeStrategy, unreadItemStrategy;

  this.preload = function(items) {
    if (items.isEmpty()) return;

    var strategies = [];

    // If the user is fixed in options, we don't need to look them up using a strategy...
    if (!user && serializeFromUserId) {
      userStrategy = new UserIdStrategy({ lean });

      var users = items.map(function(i) {
        return i.fromUserId;
      });
      strategies.push(userStrategy.preload(users));
    }

    if (serializeToTroupeId) {
      troupeStrategy = new TroupeIdStrategy({ lean });

      const troupeIds = items.map(function(i) {
        return i.toTroupeId;
      });
      strategies.push(troupeStrategy.preload(troupeIds));
    }

    if (currentUserId) {
      unreadItemStrategy = new UnreadItemStrategy({
        userId: currentUserId,
        roomId: troupeId
      });
      strategies.push(unreadItemStrategy.preload());
    }

    return Promise.all(strategies);
  };

  function safeArray(array) {
    if (!array) return [];
    return array;
  }

  function undefinedForEmptyArray(array) {
    if (!array) return undefined;
    if (!array.length) return undefined;
    return array;
  }

  function mapUser(userId) {
    if (!serializeFromUserId) {
      return userId;
    } else if (userLookups) {
      if (!userLookups[userId]) {
        userLookups[userId] = userStrategy.map(userId);
      }

      return userId;
    } else {
      return userStrategy.map(userId);
    }
  }

  function mapVirtualUser(virtualUser) {
    if (!serializeFromUserId) {
      return undefined;
    } else if (userLookups) {
      const mockUserId = getMockIdFromVirtualUser(virtualUser);
      if (!userLookups[mockUserId]) {
        userLookups[mockUserId] = transformVirtualUserIntoMockedFromUser(virtualUser);
      }

      return mockUserId;
    } else {
      return transformVirtualUserIntoMockedFromUser(virtualUser);
    }
  }

  this.map = function(item) {
    // If there is no unread strategy(meaning currentUserId was undefined), don't define how it's unread/read.
    //
    // We don't want to default to true/false because even when someone is signed in,
    // some places of code don't define `currentUserId`. We don't want to accidentally
    // override the actual value. See `live-collection-chats.js` as an example
    var unread = unreadItemStrategy ? unreadItemStrategy.map(item._id) : undefined;

    var castArray = lean ? undefinedForEmptyArray : safeArray;

    var initial;
    if (initialId) {
      initial = mongoUtils.objectIDsEqual(item._id, initialId);
    }

    const serializedData = {
      id: item._id,
      text: item.text,
      status: item.status,
      html: item.html,
      sent: formatDate(item.sent),
      editedAt: item.editedAt ? formatDate(item.editedAt) : undefined,
      parentId: item.parentId,
      threadMessageCount: item.threadMessageCount,
      unread: unread,
      readBy: item.readBy ? item.readBy.length : undefined,
      urls: castArray(item.urls),
      initial: initial || undefined,
      mentions: castArray(
        item.mentions &&
          _.map(item.mentions, function(m) {
            return {
              screenName: m.screenName,
              userId: m.userId,
              userIds: m.userIds, // For groups
              group: m.group || undefined,
              announcement: m.announcement || undefined
            };
          })
      ),
      issues: castArray(item.issues),
      meta: castArray(item.meta),
      highlights: item.highlights,
      v: getVersion(item)
    };

    if (troupeStrategy) {
      serializedData.toTroupe = troupeStrategy.map(item.toTroupeId);
    }

    if (item.virtualUser) {
      serializedData.virtualUser = {
        type: item.virtualUser.type,
        externalId: item.virtualUser.externalId,
        displayName: item.virtualUser.displayName,
        avatarUrl: item.virtualUser.avatarUrl
          ? generateProxyUrl(item.virtualUser.avatarUrl)
          : undefined
      };

      // Mock the fromUser at a basic level for legacy apps (Android and iOS)
      serializedData.fromUser = mapVirtualUser(item.virtualUser);
    } else {
      serializedData.fromUser = user ? user : mapUser(item.fromUserId);
    }

    return serializedData;
  };

  this.postProcess = function(serialized) {
    if (useLookups) {
      return {
        items: serialized.toArray(),
        lookups: {
          users: userLookups
        }
      };
    } else {
      return serialized.toArray();
    }
  };
}

ChatStrategy.prototype = {
  name: 'ChatStrategy'
};

module.exports = ChatStrategy;
