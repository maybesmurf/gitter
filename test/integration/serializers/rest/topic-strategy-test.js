"use strict";

var env = require('gitter-web-env');
var nconf = env.config;
var testRequire = require('../../test-require');
var fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
var assertUtils = require('../../assert-utils')
var serialize = require('gitter-web-serialization/lib/serialize');
var serializeObject = require('gitter-web-serialization/lib/serialize-object');
var TopicStrategy = testRequire('./serializers/rest/topic-strategy');
var subscriberService = require('gitter-web-topic-notifications/lib/subscriber-service');
var ForumObject = require('gitter-web-topic-notifications/lib/forum-object');
var assert = require('assert');

var LONG_AGO = '2014-01-01T00:00:00.000Z';

// TODO: move this somewhere reusable otherwise we'll end up with it
// copy/pasted everywhere
function makeHash() {
  var hash = {};
  for(var i = 0; i < arguments.length; i = i + 2) {
    hash[arguments[i]] = arguments[i + 1];
  }
  return hash;
}

describe('TopicStrategy #slow', function() {
  var blockTimer = require('../../block-timer');
  before(blockTimer.on);
  after(blockTimer.off);

  var fixture = fixtureLoader.setup({
    user1: {},
    forum1: {},
    category1: {
      forum: 'forum1'
    },
    topic1: {
      user: 'user1',
      forum: 'forum1',
      category: 'category1',
      sent: new Date(LONG_AGO),
      repliesTotal: 1
    },
    reply1: {
      user: 'user1',
      forum: 'forum1',
      topic: 'topic1',
      sent: new Date(LONG_AGO)
    }
  });

  it('should serialize a topic', function() {
    var strategy = TopicStrategy.standard({});

    var topic = fixture.topic1;
    var category = fixture.category1;
    var user = fixture.user1;

    return serialize([topic], strategy)
      .then(function(s) {
        assertUtils.assertSerializedEqual(s, [{
          id: topic.id,
          title: topic.title,
          slug: topic.slug,
          body: {
            text: topic.text,
            html: topic.html
          },
          sticky: topic.sticky,
          tags: [],
          category: {
            id: category.id,
            name: category.name,
            slug: category.slug
          },
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username,
          },
          subscribed: false,
          repliesTotal: 1,
          replyingUsers: [{
            "id": user.id,
            "username": user.username,
            "displayName": user.displayName,
            "avatarUrl":  nconf.get('avatar:officialHost') + '/g/u/' + user.username
          }],
          sent: LONG_AGO,
          editedAt: null,
          lastChanged: LONG_AGO,
          lastModified: LONG_AGO,
          v: 1
        }])
      });
  });

  it('should serialize a topic with nested replies', function() {
    var user = fixture.user1;
    var category = fixture.category1;
    var topic = fixture.topic1;
    var reply = fixture.reply1;

    var strategy = TopicStrategy.nested({
      currentUserId: user._id
    });

    return serialize([topic], strategy)
      .then(function(s) {
        assertUtils.assertSerializedEqual(s, [{
          id: topic.id,
          title: topic.title,
          slug: topic.slug,
          body: {
            text: topic.text,
            html: topic.html
          },
          sticky: topic.sticky,
          tags: [],
          category: {
            id: category.id,
            name: category.name,
            slug: category.slug
          },
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username
          },
          subscribed: false,
          replies: [{
            id: reply.id,
            body: {
              text: reply.text,
              html: reply.html
            },
            user: {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username
            },
            subscribed: false,
            commentsTotal: 0,
            sent: LONG_AGO,
            editedAt: null,
            lastChanged: LONG_AGO,
            lastModified: LONG_AGO,
            v: 1
          }],
          repliesTotal: 1,
          replyingUsers: [{
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username
          }],
          sent: LONG_AGO,
          editedAt: null,
          lastChanged: LONG_AGO,
          lastModified: LONG_AGO,
          v: 1
        }])
      });
  });

  it("should serialize a topic with lookups=['user']", function() {
    var strategy = TopicStrategy.standard({ lookups: ['user'] });

    var topic = fixture.topic1;
    var category = fixture.category1;
    var user = fixture.user1;

    return serialize([topic], strategy)
      .then(function(s) {
        assertUtils.assertSerializedEqual(s, {
          items: [{
            id: topic.id,
            title: topic.title,
            slug: topic.slug,
            body: {
              text: topic.text,
              html: topic.html,
            },
            sticky: topic.sticky,
            tags: [],
            category: {
              id: category.id,
              name: category.name,
              slug: category.slug
            },
            user: fixture.user1.id,
            subscribed: false,
            repliesTotal: 1,
            replyingUsers: [{
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username
            }],
            sent: LONG_AGO,
            editedAt: null,
            lastChanged: LONG_AGO,
            lastModified: LONG_AGO,
            v: 1
          }],
          lookups: {
            users: makeHash(fixture.user1.id, {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username,
            })
          }
        })
      });
  });

  it("should serialize a topic with lookups=['category']", function() {
    var strategy = TopicStrategy.standard({ lookups: ['category'] });

    var topic = fixture.topic1;
    var category = fixture.category1;
    var user = fixture.user1;

    return serialize([topic], strategy)
      .then(function(s) {
        assertUtils.assertSerializedEqual(s, {
          items: [{
            id: topic.id,
            title: topic.title,
            slug: topic.slug,
            body: {
              text: topic.text,
              html: topic.html
            },
            sticky: topic.sticky,
            tags: [],
            category: fixture.category1.id,
            user: {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username,
            },
            subscribed: false,
            repliesTotal: 1,
            replyingUsers: [{
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl:  nconf.get('avatar:officialHost') + '/g/u/' + user.username
            }],
            sent: LONG_AGO,
            editedAt: null,
            lastChanged: LONG_AGO,
            lastModified: LONG_AGO,
            v: 1
          }],
          lookups: {
            categories: makeHash(fixture.category1.id, {
              id: category.id,
              name: category.name,
              slug: category.slug
            })
          }
        })
      });
  });

  it('should tell a user when they are subscribed to a forum', function() {
    var forumObject = ForumObject.createForTopic(fixture.forum1._id, fixture.topic1._id);
    var userId = fixture.user1._id;

    return subscriberService.addSubscriber(forumObject, userId)
      .then(function() {
        var strategy = TopicStrategy.nested({
          currentUserId: userId
        });

        return serializeObject(fixture.topic1, strategy);
      })
      .then(function(serialized) {
        assert.strictEqual(serialized.subscribed, true);
      });
  });

  it('should tell a user when they are subscribed to a reply within a topic', function() {
    var forumObject = ForumObject.createForReply(fixture.forum1._id, fixture.topic1._id, fixture.reply1._id);
    var userId = fixture.user1._id;

    return subscriberService.addSubscriber(forumObject, userId)
      .then(function() {
        var strategy = TopicStrategy.nested({
          currentUserId: userId
        });

        return serializeObject(fixture.topic1, strategy);
      })
      .then(function(serialized) {
        assert.strictEqual(serialized.replies[0].subscribed, true);
      })
  });
});
