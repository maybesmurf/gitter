'use strict';

const assert = require('assert');
const sinon = require('sinon');
const proxyquireNoCallThru = require('proxyquire').noCallThru();
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const TestError = require('gitter-web-test-utils/lib/test-error');
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const roomMembershipService = require('gitter-web-rooms/lib/room-membership-service');
const chatService = require('gitter-web-chats');
const troupeService = require('gitter-web-rooms/lib/troupe-service');
const roomService = require('gitter-web-rooms');
const env = require('gitter-web-env');
const config = env.config;

const MatrixEventHandler = require('../lib/matrix-event-handler');
const store = require('../lib/store');
const getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid = require('../lib/get-gitter-dm-room-uri-by-gitter-user-id-and-other-person-mxid');
const getMxidForGitterUser = require('../lib/get-mxid-for-gitter-user');

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');

function createEventData(extraEventData) {
  return {
    room_id: `!${fixtureLoader.generateGithubId()}:localhost`,
    event_id: `$${fixtureLoader.generateGithubId()}:localhost`,
    sender: '@alice:localhost',
    type: 'm.room.message',
    origin_server_ts: Date.now(),
    content: {},
    ...extraEventData
  };
}

describe('matrix-event-handler', () => {
  let matrixEventHandler;
  let matrixBridge;
  beforeEach(() => {
    const intentSpies = {
      createRoom: () => ({
        room_id: `!${fixtureLoader.generateGithubId()}:localhost`
      }),
      createAlias: () => {},
      join: sinon.spy(),
      getProfileInfo: () => ({
        displayname: 'Alice',
        avatar_url: 'mxc://abcedf1234'
      }),
      setDisplayName: () => {},
      setAvatarUrl: () => {},
      matrixClient: {
        mxcUrlToHttp: () => 'myavatar.png'
      },
      sendMessage: sinon.spy()
    };

    matrixBridge = {
      getIntent: (/*userId*/) => intentSpies
    };
  });

  describe('onAliasQuery', () => {
    const fixture = fixtureLoader.setupEach({
      group1: {},
      userBridge1: {},
      troupe1: {
        uri: 'matrixbridgealiasqueryoneunderscore/test'
      },
      troupeWithUnderscore1: {
        uri: 'matrixbridgealiasquery_withunderscore/test'
      },
      troupePrivate1: {
        uri: 'matrixbridgeprivate/private-test',
        securityDescriptor: {
          members: 'INVITE',
          admins: 'MANUAL',
          public: false
        }
      },
      deleteDocuments: {
        Troupe: [
          {
            lcUri: 'matrixbridgealiasqueryoneunderscore/test'
          },
          {
            lcUri: 'matrixbridgealiasquery_withunderscore/test'
          },
          {
            lcUri: 'matrixbridgeprivate/private-test'
          }
        ]
      }
    });

    beforeEach(() => {
      matrixEventHandler = new MatrixEventHandler(
        matrixBridge,
        fixture.userBridge1.username,
        fixture.group1.uri
      );
    });

    it('Normal room is found (#foo_bar:gitter.im)', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

      const result = await matrixEventHandler.onAliasQuery(
        '#matrixbridgealiasqueryoneunderscore_test:gitter.im',
        'matrixbridgealiasqueryoneunderscore_test'
      );

      assert.deepEqual(result, {
        roomId: matrixRoomId
      });
    });

    it('Room with underscore in name is still found (#foo_bar_baz:gitter.im)', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      await store.storeBridgedRoom(fixture.troupeWithUnderscore1.id, matrixRoomId);

      const result = await matrixEventHandler.onAliasQuery(
        '#matrixbridgealiasquery_withunderscore_test:gitter.im',
        'matrixbridgealiasquery_withunderscore_test'
      );

      assert.deepEqual(result, {
        roomId: matrixRoomId
      });
    });

    it('Private room is not found', async () => {
      const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
      await store.storeBridgedRoom(fixture.troupePrivate1.id, matrixRoomId);

      const result = await matrixEventHandler.onAliasQuery(
        '#matrixbridgeprivate_private-test:gitter.im',
        'matrixbridgeprivate_private-test'
      );

      assert.strictEqual(result, null);
    });

    it('non-existant room (#foo_bar:gitter.im)', async () => {
      const result = await matrixEventHandler.onAliasQuery('#dne_room:gitter.im', 'dne_room');
      assert.strictEqual(result, null);
    });

    it('Alias without an underscore means no slash in URI so a room will not be found (#foo:gitter.im)', async () => {
      const result = await matrixEventHandler.onAliasQuery('#foo:gitter.im', 'foo');
      assert.strictEqual(result, null);
    });
  });

  describe('onEventData', () => {
    describe('handleChatMessageEditEvent', () => {
      const fixture = fixtureLoader.setupEach({
        userBridge1: {},
        group1: {},
        troupe1: {},
        messageFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my original message from matrix'
        },
        messageOldFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my original old message from matrix',
          sent: new Date('2020-12-01T00:00:00.000Z')
        },
        messageStatusFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my original emote/status message from matrix',
          status: true
        }
      });

      beforeEach(() => {
        matrixEventHandler = new MatrixEventHandler(
          matrixBridge,
          fixture.userBridge1.username,
          fixture.group1.uri
        );
      });

      it('When we receive message edit from Matrix, update the Gitter message in Gitter room', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: '* my edited message from matrix',
            'm.new_content': { body: 'my edited message from matrix', msgtype: 'm.text' },
            'm.relates_to': {
              event_id: matrixMessageEventId,
              rel_type: 'm.replace'
            }
          }
        });
        await store.storeBridgedMessage(
          fixture.messageFromVirtualUser1,
          eventData.room_id,
          matrixMessageEventId
        );

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        const targetMessage = messages.find(m => m.id === fixture.messageFromVirtualUser1.id);
        assert.strictEqual(messages.length, 3);
        assert.strictEqual(targetMessage.text, 'my edited message from matrix');
      });

      it('When we receive emote/status message edit from Matrix, update the Gitter message in Gitter room', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: '* my edited emote/status message from matrix',
            msgtype: 'm.emote',
            'm.new_content': {
              body: 'my edited emote/status message from matrix',
              msgtype: 'm.emote'
            },
            'm.relates_to': {
              event_id: matrixMessageEventId,
              rel_type: 'm.replace'
            }
          }
        });
        await store.storeBridgedMessage(
          fixture.messageStatusFromVirtualUser1,
          eventData.room_id,
          matrixMessageEventId
        );

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 3);
        const targetMessage = messages.find(m => m.id === fixture.messageStatusFromVirtualUser1.id);
        assert.strictEqual(
          targetMessage.text,
          '@alice:localhost my edited emote/status message from matrix'
        );
        assert.strictEqual(targetMessage.status, true);
      });

      it('When we receive message edit from Matrix outside of the Gitter edit time window, send a new Gitter message with reference to original message the Gitter room', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: '* my edited message from matrix',
            'm.new_content': { body: 'my edited message from matrix', msgtype: 'm.text' },
            'm.relates_to': {
              event_id: matrixMessageEventId,
              rel_type: 'm.replace'
            }
          }
        });
        await store.storeBridgedMessage(
          fixture.messageOldFromVirtualUser1,
          eventData.room_id,
          matrixMessageEventId
        );

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        const targetMessage = messages.find(m => m.id === fixture.messageOldFromVirtualUser1.id);
        const newMessage = messages[3];
        assert.strictEqual(messages.length, 4);
        assert.strictEqual(targetMessage.text, 'my original old message from matrix');
        assert.strictEqual(newMessage.text.split('): ')[1], 'my edited message from matrix');
      });

      it('Ignore message edit from Matrix when there is no matching message', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: '* my edited message from matrix',
            'm.new_content': { body: 'my edited message from matrix', msgtype: 'm.text' },
            'm.relates_to': {
              event_id: matrixMessageEventId,
              rel_type: 'm.replace'
            }
          }
        });
        // We purposely do not associate the bridged message. We are testing that the
        // edit is ignored if there is no association in the database.
        //await store.storeBridgedMessage(fixture.messageFromVirtualUser1, eventData.room_id, matrixMessageEventId);

        try {
          await matrixEventHandler.onEventData(eventData);
        } catch (err) {
          // we expect an error and not process the event
        }

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        const targetMessage = messages.find(m => m.id === fixture.messageFromVirtualUser1.id);
        assert.strictEqual(messages.length, 3);
        assert.strictEqual(targetMessage.text, 'my original message from matrix');
      });
    });

    describe('handleChatMessageCreateEvent', () => {
      const fixture = fixtureLoader.setupEach({
        userBridge1: {},
        user1: {},
        group1: {},
        troupe1: {},
        troupeWithThreads1: {},
        troupePrivate1: {
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        },
        messageParent1: {
          user: 'user1',
          troupe: 'troupeWithThreads1',
          text: 'some parent message'
        },
        messageThread1: {
          parent: 'messageParent1',
          user: 'user1',
          troupe: 'troupeWithThreads1',
          text: 'some child message'
        }
      });

      beforeEach(() => {
        matrixEventHandler = new MatrixEventHandler(
          matrixBridge,
          fixture.userBridge1.username,
          fixture.group1.uri
        );
      });

      it('When we receive Matrix message, creates Gitter message in Gitter room', async () => {
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix message'
          }
        });
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].text, 'my matrix message');
        assert.strictEqual(messages[0].virtualUser.externalId, 'alice:localhost');
        assert.strictEqual(messages[0].virtualUser.displayName, 'Alice');
      });

      it('When we receive Matrix emote/status (/me) message, creates Gitter message in Gitter room', async () => {
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix emote/status message',
            msgtype: 'm.emote'
          }
        });
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].text, '@alice:localhost my matrix emote/status message');
        assert.strictEqual(messages[0].status, true);
        assert.strictEqual(messages[0].virtualUser.externalId, 'alice:localhost');
        assert.strictEqual(messages[0].virtualUser.displayName, 'Alice');
      });

      it('reply to message starts threaded conversation', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix reply',
            'm.relates_to': {
              'm.in_reply_to': {
                event_id: matrixMessageEventId
              }
            }
          }
        });
        await store.storeBridgedRoom(fixture.troupeWithThreads1.id, eventData.room_id);
        // Replying to a parent message
        await store.storeBridgedMessage(
          fixture.messageParent1,
          eventData.room_id,
          matrixMessageEventId
        );

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(
          fixture.troupeWithThreads1.id,
          { includeThreads: true }
        );
        assert.strictEqual(messages.length, 3);
        assert.strictEqual(messages[2].text, 'my matrix reply');
        assert(mongoUtils.isLikeObjectId(messages[2].parentId, fixture.messageParent1.id));
      });

      it("reply to message in thread that isn't the parent puts it in the thread correctly", async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix reply',
            'm.relates_to': {
              'm.in_reply_to': {
                event_id: matrixMessageEventId
              }
            }
          }
        });
        await store.storeBridgedRoom(fixture.troupeWithThreads1.id, eventData.room_id);
        // Replying to a message in the thread
        await store.storeBridgedMessage(
          fixture.messageThread1,
          eventData.room_id,
          matrixMessageEventId
        );

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(
          fixture.troupeWithThreads1.id,
          { includeThreads: true }
        );
        assert.strictEqual(messages.length, 3);
        assert.strictEqual(messages[2].text, 'my matrix reply');
        assert(mongoUtils.isLikeObjectId(messages[2].parentId, fixture.messageParent1.id));
      });

      it(`reply to message where we can't find the associated bridged Gitter message falls back to message in MMF with warning note`, async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix reply',
            'm.relates_to': {
              'm.in_reply_to': {
                event_id: matrixMessageEventId
              }
            }
          }
        });
        await store.storeBridgedRoom(fixture.troupeWithThreads1.id, eventData.room_id);

        // We purposely do not associate the bridged message. We are testing that the
        // fallback to a MMF message with a warning note if there is no association in the database.
        //await store.storeBridgedMessage(fixture.messageParent1,eventData.room_id, matrixMessageEventId);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(
          fixture.troupeWithThreads1.id,
          { includeThreads: true }
        );
        assert.strictEqual(messages.length, 3);
        assert.strictEqual(
          messages[2].text,
          `> This message is replying to a [Matrix event](https://matrix.to/#/${eventData.room_id}/${matrixMessageEventId}) but we were unable to find associated bridged Gitter message to put it in the appropriate threaded conversation.\n\nmy matrix reply`
        );
        assert.strictEqual(messages[2].parentId, undefined);
      });

      it('When we receive Matrix image upload, creates Gitter message linking the image in Gitter room', async () => {
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my-image.jpeg',
            info: {
              h: 807,
              mimetype: 'image/jpeg',
              size: 176995,
              thumbnail_info: [Object],
              thumbnail_url: 'mxc://my.matrix.host/DSVnwDtcZeNoBEjUnsFxdelN',
              w: 1217
            },
            msgtype: 'm.image',
            url: 'mxc://my.matrix.host/yjyeYJIBdJGkYvYoLuvPfBuS'
          }
        });
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(
          messages[0].text,
          `[my-image.jpeg](${homeserverUrl}/_matrix/media/v1/download/my.matrix.host/yjyeYJIBdJGkYvYoLuvPfBuS)\n[![my-image.jpeg](${homeserverUrl}/_matrix/media/v1/download/my.matrix.host/DSVnwDtcZeNoBEjUnsFxdelN)](${homeserverUrl}/_matrix/media/v1/download/my.matrix.host/yjyeYJIBdJGkYvYoLuvPfBuS)`
        );
        assert.strictEqual(messages[0].virtualUser.externalId, 'alice:localhost');
        assert.strictEqual(messages[0].virtualUser.displayName, 'Alice');
      });

      it('When profile API request fails, still sends message', async () => {
        const failingMatrixBridge = {
          getIntent: (/*userId*/) => ({
            getProfileInfo: () => {
              throw new Error('Fake error and failed to fetch profile info for a user');
            }
          })
        };

        matrixEventHandler = new MatrixEventHandler(
          failingMatrixBridge,
          fixture.userBridge1.username,
          fixture.group1.uri
        );

        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix message'
          }
        });
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].text, 'my matrix message');
        assert.strictEqual(messages[0].virtualUser.externalId, 'alice:localhost');
        assert.strictEqual(messages[0].virtualUser.displayName, 'alice');
      });

      it('does not create messages in private rooms', async () => {
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix message'
          }
        });
        await store.storeBridgedRoom(fixture.troupePrivate1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupePrivate1.id);
        assert.strictEqual(messages.length, 0);
      });

      it('ignore old events', async () => {
        const eventData = createEventData({
          type: 'm.room.message',
          content: {
            body: 'my matrix message'
          },
          origin_server_ts: Date.now() - 1000 * 60 * 31
        });
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 0);
      });

      it('mangled event does not get processed', async () => {
        const eventData = {
          // Messages should not contain state_key
          state_key: '@MadLittleMods-5f762e89986e461e663059c2:my.matrix.host',
          // No sender is present

          type: 'm.room.message',
          room_id: `!${fixtureLoader.generateGithubId()}:localhost`,
          content: {
            body: 'my matrix message'
          },
          origin_server_ts: 0
        };
        await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

        await matrixEventHandler.onEventData(eventData);

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 0);
      });

      describe('inviteGitterUserToDmRoomIfNeeded', () => {
        it('should invite Gitter user back to Matrix DM room if they have left', async () => {
          const eventData = createEventData({
            type: 'm.room.message',
            content: {
              body: 'my matrix message'
            }
          });

          // Store an existing bridged room entry for the DM room
          const newDmRoom = await matrixEventHandler.gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            eventData.sender
          );
          await store.storeBridgedRoom(newDmRoom._id, eventData.room_id);

          // Remove the user from the room
          await roomService.removeUserFromRoom(newDmRoom, fixture.user1);

          // Make sure the user is not in the room before to see if the test is setup correctly
          const beforeMembership = await roomMembershipService.checkRoomMembership(
            newDmRoom._id,
            fixture.user1.id
          );
          assert.strictEqual(beforeMembership, false);

          // A new DM message from Matrix arrived
          await matrixEventHandler.onEventData(eventData);

          // The Gitter user is now back in the DM room to know about the new message
          const afterMembership = await roomMembershipService.checkRoomMembership(
            newDmRoom._id,
            fixture.user1.id
          );
          assert.strictEqual(afterMembership, true);
        });

        it('should work if user already in DM room (not mess anything up)', async () => {
          const eventData = createEventData({
            type: 'm.room.message',
            content: {
              body: 'my matrix message'
            }
          });

          // Store an existing bridged room entry for the DM room
          const newDmRoom = await matrixEventHandler.gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            eventData.sender
          );
          await store.storeBridgedRoom(newDmRoom._id, eventData.room_id);

          // A new DM message from Matrix arrived
          await matrixEventHandler.onEventData(eventData);

          // The Gitter user is still in the DM room to know about the new message
          const afterMembership = await roomMembershipService.checkRoomMembership(
            newDmRoom._id,
            fixture.user1.id
          );
          assert.strictEqual(afterMembership, true);
        });

        it('should still allow message to send if Gitter user failed to join', async () => {
          const ProxiedMatrixEventHandler = proxyquireNoCallThru('../lib/matrix-event-handler', {
            'gitter-web-rooms': {
              // Make the joinRoom call fail so the Gitter user fails to join back
              joinRoom: () => Promise.reject('Fake failed to join room')
            }
          });

          matrixEventHandler = new ProxiedMatrixEventHandler(
            matrixBridge,
            fixture.userBridge1.username,
            fixture.group1.uri
          );

          const eventData = createEventData({
            type: 'm.room.message',
            content: {
              body: 'my matrix message'
            }
          });

          // Store an existing bridged room entry for the DM room
          const newDmRoom = await matrixEventHandler.gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            eventData.sender
          );
          await store.storeBridgedRoom(newDmRoom._id, eventData.room_id);

          // Remove the user from the room
          await roomService.removeUserFromRoom(newDmRoom, fixture.user1);

          // Make sure the user is not in the room before to see if the test is setup correctly
          const beforeMembership = await roomMembershipService.checkRoomMembership(
            newDmRoom._id,
            fixture.user1.id
          );
          assert.strictEqual(beforeMembership, false);

          // A new DM message from Matrix arrived
          await matrixEventHandler.onEventData(eventData);

          // The Gitter user was unable to join back so we should not see them in the room
          const afterMembership = await roomMembershipService.checkRoomMembership(
            newDmRoom._id,
            fixture.user1.id
          );
          assert.strictEqual(afterMembership, false);
        });

        it('should not invite anyone for non-DM room', async () => {
          const eventData = createEventData({
            type: 'm.room.message',
            content: {
              body: 'my matrix message'
            }
          });
          await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

          sinon.spy(matrixEventHandler, 'inviteGitterUserToDmRoomIfNeeded');

          await matrixEventHandler.onEventData(eventData);

          // null means no invite was necessary for this room
          const inviteResult = await matrixEventHandler.inviteGitterUserToDmRoomIfNeeded.firstCall
            .returnValue;
          assert.strictEqual(inviteResult, null);
        });

        it('messages from the bridge bot do not trigger invites to be sent out (avoid feedback loop)', async () => {
          const eventData = createEventData({
            type: 'm.room.message',
            content: {
              body: 'my matrix message'
            },
            sender: matrixEventHandler.matrixUtils.getMxidForMatrixBridgeUser()
          });
          await store.storeBridgedRoom(fixture.troupe1.id, eventData.room_id);

          sinon.spy(matrixEventHandler, 'inviteGitterUserToDmRoomIfNeeded');

          await matrixEventHandler.onEventData(eventData);

          assert.strictEqual(matrixEventHandler.inviteGitterUserToDmRoomIfNeeded.callCount, 0);
        });
      });
    });

    describe('handleChatMessageDeleteEvent', () => {
      const fixture = fixtureLoader.setupEach({
        userBridge1: {},
        group1: {},
        troupe1: {},
        messageFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my original message from matrix'
        }
      });

      beforeEach(() => {
        matrixEventHandler = new MatrixEventHandler(
          matrixBridge,
          fixture.userBridge1.username,
          fixture.group1.uri
        );
      });

      it('When we receive Matrix message redaction/deletion, deletes Gitter message in Gitter room', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.redaction',
          redacts: matrixMessageEventId
        });
        await store.storeBridgedMessage(
          fixture.messageFromVirtualUser1,
          eventData.room_id,
          matrixMessageEventId
        );

        const messagesBefore = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messagesBefore.length, 1);

        await matrixEventHandler.onEventData(eventData);

        const messagesAfter = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messagesAfter.length, 0);
      });

      it('Ignore message delete/redaction from Matrix when there is no matching message', async () => {
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        const eventData = createEventData({
          type: 'm.room.redaction',
          redacts: matrixMessageEventId
        });
        // We purposely do not associate the bridged message. We are testing that the
        // deletion is ignored if there is no association in the database.
        //await store.storeBridgedMessage(fixture.messageFromVirtualUser1, eventData.room_id, matrixMessageEventId);

        try {
          await matrixEventHandler.onEventData(eventData);
        } catch (err) {
          // we expect an error and not process the event
        }

        const messages = await chatService.findChatMessagesForTroupe(fixture.troupe1.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].text, 'my original message from matrix');
      });
    });

    describe('handleInvitationEvent', () => {
      const fixture = fixtureLoader.setupEach({
        userBridge1: {},
        group1: {},
        user1: {},
        userRemoved: {
          state: 'REMOVED'
        },
        troupe1: {},
        messageFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my original message from matrix'
        }
      });

      beforeEach(() => {
        matrixEventHandler = new MatrixEventHandler(
          matrixBridge,
          fixture.userBridge1.username,
          fixture.group1.uri
        );
      });

      it('When we receive a Matrix invite, the bridge bot user joins the room', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: '@gitter-badger:my.matrix.host',
          content: {
            membership: 'invite'
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // Bot joins the room
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 1);
      });

      it('When we receive a Matrix invite for another user, does not cause our bot to try to join the room', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: '@some-random-user:my.matrix.host',
          content: {
            membership: 'invite'
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // Bot does not join the room
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 0);
      });

      it('When we receive a Matrix DM invite for a Gitter user, creates a Gitter room', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: getMxidForGitterUser(fixture.user1),
          content: {
            membership: 'invite',
            is_direct: true
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // Bridged gitter user joins the room on Matrix
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 1);

        // Gitter user joins the new DM room on Gitter
        const newDmRoom = await troupeService.findByUri(
          getGitterDmRoomUriByGitterUserIdAndOtherPersonMxid(fixture.user1.id, eventData.sender)
        );
        assert(newDmRoom);
        const isRoomMember = await roomMembershipService.checkRoomMembership(
          newDmRoom._id,
          fixture.user1.id
        );
        assert.strictEqual(isRoomMember, true);
      });

      it('when we receive another Matrix DM invite for a DM we already have setup, will update the matrixRoomId in the bridged room entry and use the new Matrix room', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: getMxidForGitterUser(fixture.user1),
          content: {
            membership: 'invite',
            is_direct: true
          }
        });

        // Store an existing bridged room entry for the DM room
        const newDmRoom = await matrixEventHandler.gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
          fixture.user1,
          eventData.sender
        );
        await store.storeBridgedRoom(newDmRoom._id, '!123:some-other-id');

        assert(newDmRoom);

        // Fire off an event that overwrites the Matrix room ID for the DM with the same Gitter user
        // because the room_id is different than what we already stored
        await matrixEventHandler.onEventData(eventData);

        // Check that the existing Gitter room is connected to the new Matrix DM room
        const storedMatrixRoomId = await store.getMatrixRoomIdByGitterRoomId(newDmRoom._id);
        assert(mongoUtils.objectIDsEqual(storedMatrixRoomId, eventData.room_id));
      });

      it('Ignores Matrix DM invite for a deleted Gitter user', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: getMxidForGitterUser(fixture.userRemoved),
          content: {
            membership: 'invite',
            is_direct: true
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // Bridged gitter user never joins the room on Matrix
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 0);
      });

      it('Ignores non-DM invites for Gitter users', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: getMxidForGitterUser(fixture.user1),
          content: {
            membership: 'invite'
            // This is commented out on purpose! We're testing an invite to a normal room
            //is_direct: true
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // Bridged gitter user joins nothing
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 0);
      });

      it('Does not work with non-existant Gitter user', async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: getMxidForGitterUser({
            id: '553d437215522ed4b3df8c50',
            username: 'some-deleted-user'
          }),
          content: {
            membership: 'invite',
            is_direct: true
          }
        });

        try {
          await matrixEventHandler.onEventData(eventData);
          assert.fail(
            new TestError(
              'Expected function to throw error and fail when processing non-existant Gitter user'
            )
          );
        } catch (err) {
          if (err instanceof TestError) {
            throw err;
          }

          assert(err);
        }
      });

      it(`Invites for non Gitter MXID's are ignored`, async () => {
        const eventData = createEventData({
          type: 'm.room.member',
          state_key: '@some-random-mxid:matrix.org',
          content: {
            membership: 'invite',
            is_direct: true
          }
        });

        await matrixEventHandler.onEventData(eventData);

        // No joins or room creation happen
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 0);
      });
    });
  });
});
