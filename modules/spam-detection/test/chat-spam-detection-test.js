'use strict';

const env = require('gitter-web-env');
var assert = require('assert');
var Promise = require('bluebird');
var proxyquireNoCallThru = require('proxyquire').noCallThru();
var fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const userService = require('gitter-web-users');
const chatService = require('gitter-web-chats');

describe('chat-spam-detection', function() {
  describe('integration tests #slow', function() {
    var fixture = fixtureLoader.setupEach({
      user1: {},
      groupDirty1: {},
      troupe1: {
        group: 'groupDirty1'
      },
      message1: {
        user: 'user1',
        troupe: 'troupe1',
        text: 'please give me ETH'
      }
    });

    let chatSpamDetection;
    beforeEach(() => {
      const mockEnv = {
        ...env,
        config: {
          get: key => {
            if (key === 'spam-detection:ethereum-dirty-group-list') {
              return [fixture.groupDirty1.id];
            }
          }
        }
      };

      chatSpamDetection = proxyquireNoCallThru('../lib/chat-spam-detection', {
        'gitter-web-env': mockEnv
      });
    });

    it('should mark messages from hellbanned user as spam', async () => {
      fixture.user1.hellbanned = true;
      const isSpammy = await chatSpamDetection.detect({
        user: fixture.user1,
        room: fixture.troupe1,
        parsedMessage: {
          text: 'Message from a banned user'
        }
      });
      assert(isSpammy);
    });

    it('should use duplicate chat detector', function() {
      var COUNTER = [];
      for (var i = 0; i < 12; i++) {
        COUNTER.push(i);
      }

      return Promise.each(COUNTER, function(v, index) {
        return chatSpamDetection
          .detect({
            user: fixture.user1,
            room: fixture.troupe1,
            parsedMessage: {
              text: '0123456789012345678912'
            }
          })
          .then(function(isSpammy) {
            var expected = index >= 10;
            assert.strictEqual(isSpammy, expected);
          });
      })
        .then(function() {
          return userService.findById(fixture.user1._id);
        })
        .then(function(user) {
          assert.strictEqual(user.hellbanned, true);
        });
    });

    it('should use ethereum spam detector', async () => {
      const isSpammy = await chatSpamDetection.detect({
        user: fixture.user1,
        room: fixture.troupe1,
        parsedMessage: {
          text: '0x1ea1F277E1A85961c337007556F1c23e5794262b'
        }
      });

      assert.strictEqual(isSpammy, true);

      // Make sure the user is hellbanned and can no longer send mesages
      const user = await userService.findById(fixture.user1._id);
      assert.strictEqual(user.hellbanned, true);

      // The spammy user's chat messages are removed from the room
      const chatMessage = await chatService.findById(fixture.message1._id);
      assert.strictEqual(chatMessage, null);
    });
  });
});
