"use strict";

var testRequire = require('../test-require');
var Q = require('bluebird-q');
var assert = require('assert');
var FAKE_USER = { id: 'superfake' };

var subscritionFindResult, countUsersInRoomResult, checkRoomMembershipResult;

var assertMemberLimit = testRequire.withProxies('./services/assert-member-limit', {
  './troupe-service': {
    checkGitHubTypeForUri: function(uri, githubType) {
      if (uri === 'org') {
        return Q.resolve(githubType == 'ORG');
      } else if (uri === 'user') {
        return Q.resolve(githubType == 'NOT_ORG');
      } else {
        return Q.resolve(false);
      }
    }
  },
  './room-membership-service': {
    checkRoomMembership: function(/*troupeId, userId*/) {
      return Q.resolve(checkRoomMembershipResult);
    },
    countMembersInRoom: function(/*troupeId*/) {
      return Q.resolve(countUsersInRoomResult);
    }
  },
  './persistence-service': {
    Subscription: { findOne: function() { return { exec: function() { return Q.resolve(subscritionFindResult); } }; } }
  }
});


describe('assert-member-limit:', function() {

  beforeEach(function() {
    subscritionFindResult = null;
    countUsersInRoomResult = 100;
    checkRoomMembershipResult = false;
  });

  describe('user room', function() {

    it('allows user to join public room', function(done) {
      var room = {
        uri: 'user/room',
        security: 'PUBLIC',
      };

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('allows user to join private room', function(done) {
      var room = {
        uri: 'user/room',
        security: 'PRIVATE',
      };


      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

  });

  describe('org room', function() {

    it('allows user to join public room', function(done) {
      var room = {
        uri: 'org/room',
        security: 'PUBLIC',
      };
      countUsersInRoomResult = 26;
      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('allows user to join private room with 0 people in the org', function(done) {
      var room = {
        uri: 'org/room',
        security: 'PRIVATE',
      };
      countUsersInRoomResult = 0;

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('allows undefined user to join private room with 10 people inside', function(done) {
      var room = {
        uri: 'org/room',
        security: 'PRIVATE'
      };
      countUsersInRoomResult = 10;
      assertMemberLimit(room, undefined).nodeify(done);
    });

    it('allows user to join private room with 24 people inside', function(done) {
      var room = {
        uri: 'org/room',
        security: 'PRIVATE'
      };
      countUsersInRoomResult = 24;
      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('throws when user tries to join private room with 25 other people inside', function(done) {
      var room = {
        uri: 'org/room',
        security: 'PRIVATE'
      };
      countUsersInRoomResult = 25;

      assertMemberLimit(room, FAKE_USER)
        .then(function() {
          done(new Error('exception not thrown'));
        }, function(err) {
          assert(err);
          assert.equal(err.status, 402);
          done();
        });
    });

    it('throws when user tries to join inherited room with 25 other people inside', function(done) {
      var room = {
        uri: 'org/room',
        security: 'INHERITED',
      };
      countUsersInRoomResult = 25;

      assertMemberLimit(room, FAKE_USER)
        .then(function() {
          done(new Error('exception not thrown'));
        }, function(err) {
          assert(err);
          assert.equal(err.status, 402);
          done();
        });
    });

    it('throws when user tries to join room with undefined security with 25 other people inside', function(done) {
      var room = {
        uri: 'org/room',
      };
      countUsersInRoomResult = 25;

      assertMemberLimit(room, FAKE_USER)
        .then(function() {
          done(new Error('exception not thrown'));
        }, function(err) {
          assert(err);
          assert.equal(err.status, 402);
          done();
        });
    });

    it('allows existing org user to join private room with 25 people inside', function(done) {
      countUsersInRoomResult = 26;
      checkRoomMembershipResult = true;

      var room = {
        uri: 'org/room',
        security: 'PRIVATE'
      };

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('allows user to join private room with 25 people in the org with paid plan', function(done) {
      subscritionFindResult = { _id: 'im a subscription!' };
      countUsersInRoomResult = 25;

      var room = {
        uri: 'org/room',
        security: 'PRIVATE',
      };

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

  });

  describe('repo room with no clear owner', function() {

    it('allows user to join public room', function(done) {
      countUsersInRoomResult = 100;
      var room = {
        uri: 'xxx/room',
        security: 'PUBLIC'
      };

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

    it('allows user to join private room', function(done) {
      countUsersInRoomResult = 100;
      var room = {
        uri: 'xxx/room',
        security: 'PRIVATE',
      };

      assertMemberLimit(room, FAKE_USER).nodeify(done);
    });

  });

});
