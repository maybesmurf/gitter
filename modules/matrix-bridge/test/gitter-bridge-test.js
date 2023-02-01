'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const chatService = require('gitter-web-chats');
const restSerializer = require('../../../server/serializers/rest-serializer');
const GitterBridge = require('../lib/gitter-bridge');
const GitterUtils = require('../lib/gitter-utils');
const store = require('../lib/store');
const getMxidForGitterUser = require('../lib/get-mxid-for-gitter-user');
const { getCanonicalAliasLocalpartForGitterRoomUri } = require('../lib/matrix-alias-utils');
const { ROOM_ADMIN_POWER_LEVEL } = require('../lib/constants');

const strategy = new restSerializer.ChatStrategy();

describe('gitter-bridge', () => {
  const overallFixtures = fixtureLoader.setupEach({
    userBridge1: {},
    group1: {}
  });

  let gitterBridge;
  let matrixBridge;
  let gitterUtils;
  beforeEach(async () => {
    const clientSpies = {
      redactEvent: sinon.spy(),
      resolveRoom: sinon.spy(),
      deleteRoomAlias: sinon.spy(),
      getDirectoryVisibility: sinon.spy(),
      setDirectoryVisibility: sinon.spy(),
      getRoomMembers: sinon.spy(),
      unstableApis: {
        getRoomAliases: sinon.spy()
      }
    };

    const intentSpies = {
      matrixClient: clientSpies,
      getStateEvent: sinon.spy(),
      sendStateEvent: sinon.spy(),
      getEvent: sinon.spy(() => ({
        event_id: `$${fixtureLoader.generateGithubId()}:localhost`,
        sender: '@alice:localhost'
      })),
      sendMessage: sinon.spy(() => ({
        event_id: `$${fixtureLoader.generateGithubId()}:localhost`
      })),
      createRoom: sinon.spy(() => ({
        room_id: `!${fixtureLoader.generateGithubId()}:localhost`
      })),
      createAlias: sinon.spy(),
      setRoomAvatar: sinon.spy(),
      getProfileInfo: sinon.spy(() => ({})),
      setDisplayName: sinon.spy(),
      uploadContent: sinon.spy(),
      setAvatarUrl: sinon.spy(),
      invite: sinon.spy(),
      join: sinon.spy(),
      leave: sinon.spy(),
      ban: sinon.spy(),
      unban: sinon.spy()
    };

    matrixBridge = {
      getIntent: sinon.spy((/*userId*/) => intentSpies)
    };

    gitterBridge = new GitterBridge(matrixBridge, overallFixtures.userBridge1.username);
    await gitterBridge.start();

    gitterUtils = new GitterUtils(
      matrixBridge,
      overallFixtures.userBridge1.username,
      overallFixtures.group1.uri
    );
  });

  describe('onDataChange', () => {
    describe('handleChatMessageCreateEvent', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        userBridge1: {},
        group1: {},
        troupe1: {
          group: 'group1'
        },
        troupePrivate1: {
          group: 'group1',
          users: ['user1'],
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        },
        message1: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter message'
        },
        message2: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter message2'
        },
        messageStatus1: {
          user: 'user1',
          troupe: 'troupe1',
          text: '@user1 my gitter status(/me) message',
          html:
            '<span data-link-type="mention" data-screen-name="user1" class="mention">@user1</span> my gitter status(/me) message',
          status: true
        },
        messageThreaded1: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter threaded message1',
          parent: 'message1'
        },
        messageThreaded2: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter threaded message2',
          parent: 'message1'
        },
        messageFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my virtualUser message'
        },
        messageFromBridgeBot1: {
          user: 'userBridge1',
          troupe: 'troupe1',
          text: `I'm the badger bridge bot`
        },
        messagePrivate1: {
          user: 'user1',
          troupe: 'troupePrivate1',
          text: 'my private gitter message'
        }
      });

      it('new message gets sent off to Matrix', async () => {
        const serializedMessage = await restSerializer.serializeObject(fixture.message1, strategy);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Room is created for something that hasn't been bridged before
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: fixture.message1.text,
          format: 'org.matrix.custom.html',
          formatted_body: fixture.message1.html,
          msgtype: 'm.text'
        });
      });

      it('new status(/me) message gets sent off to Matrix', async () => {
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messageStatus1,
          strategy
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Room is created for something that hasn't been bridged before
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: 'my gitter status(/me) message',
          format: 'org.matrix.custom.html',
          formatted_body: 'my gitter status(/me) message',
          msgtype: 'm.emote'
        });
      });

      it('subsequent multiple messages go to the same room', async () => {
        const serializedMessage1 = await restSerializer.serializeObject(fixture.message1, strategy);
        const serializedMessage2 = await restSerializer.serializeObject(fixture.message2, strategy);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage1
        });

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage2
        });

        // Room is only created once
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);

        // Messages are sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 2);

        const sendMessageCall1 = matrixBridge.getIntent().sendMessage.getCall(0);
        const sendMessageCall2 = matrixBridge.getIntent().sendMessage.getCall(1);
        // Make sure the messages were sent to the same room
        assert.strictEqual(sendMessageCall1.args[0], sendMessageCall2.args[0]);
      });

      it('threaded conversation reply gets sent off to Matrix', async () => {
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messageThreaded1,
          strategy
        );

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const parentMessageEventId = `$${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, parentMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: fixture.messageThreaded1.text,
          format: 'org.matrix.custom.html',
          formatted_body: fixture.messageThreaded1.html,
          msgtype: 'm.text',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: parentMessageEventId,
            is_falling_back: true,
            'm.in_reply_to': {
              event_id: parentMessageEventId
            }
          }
        });
      });

      it('threaded conversation replies to last message in thread gets sent off to Matrix', async () => {
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messageThreaded2,
          strategy
        );

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const parentMessageEventId = `$${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, parentMessageEventId);
        const threadReplyMessageEventId1 = `$${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedMessage(
          fixture.messageThreaded1,
          matrixRoomId,
          threadReplyMessageEventId1
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: fixture.messageThreaded2.text,
          format: 'org.matrix.custom.html',
          formatted_body: fixture.messageThreaded2.html,
          msgtype: 'm.text',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: parentMessageEventId,
            is_falling_back: true,
            'm.in_reply_to': {
              event_id: threadReplyMessageEventId1
            }
          }
        });
      });

      // This is a edge case in the transition between no Matrix bridge and Matrix.
      // I don't think we need to worry too much about what happens. Just want a test to know
      // something happens.
      it('threaded conversation reply where the parent does not exist on Matrix still gets sent', async () => {
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messageThreaded1,
          strategy
        );

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        // We purposely do not associate the bridged message. We are testing that the
        // message is ignored if the parent message event is not in the database.
        //const parentMessageEventId = `$${fixtureLoader.generateGithubId()}:localhost`;
        //await store.storeBridgedMessage(fixture.message1, matrixRoomId, parentMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: fixture.messageThreaded1.text,
          format: 'org.matrix.custom.html',
          formatted_body: fixture.messageThreaded1.html,
          msgtype: 'm.text'
        });
      });

      it('new message from virtualUser is suppressed (no echo back and forth)', async () => {
        const serializedVirtualUserMessage = await restSerializer.serializeObject(
          fixture.messageFromVirtualUser1,
          strategy
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'create',
          model: serializedVirtualUserMessage
        });

        // No room creation
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 0);
        // No message sent
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
      });

      it('new message in private room is bridged', async () => {
        const strategy = new restSerializer.ChatStrategy();
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messagePrivate1,
          strategy
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupePrivate1.id}/chatMessages`,
          operation: 'create',
          model: serializedMessage
        });

        // Room is created for something that hasn't been bridged before
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().createRoom.getCall(0).args[0], {
          createAsClient: true,
          options: {
            name: fixture.troupePrivate1.uri,
            room_alias_name: getCanonicalAliasLocalpartForGitterRoomUri(fixture.troupePrivate1.uri),
            visibility: 'private',
            preset: 'private_chat'
          }
        });

        // Message is sent to the new room
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
      });

      describe('inviteMatrixUserToDmRoomIfNeeded', async () => {
        const otherPersonMxid = '@alice:localhost';

        let matrixRoomId;
        let serializedMessage;
        beforeEach(async () => {
          matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;

          serializedMessage = await restSerializer.serializeObject(fixture.message1, strategy);
        });

        it('should invite Matrix user back to Matrix DM room if they have left', async () => {
          const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            otherPersonMxid
          );
          await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

          // Stub the other user as left the room
          matrixBridge.getIntent().getStateEvent = (targetRoomId, type, stateKey) => {
            if (
              targetRoomId === matrixRoomId &&
              type === 'm.room.member' &&
              stateKey === otherPersonMxid
            ) {
              return {
                membership: 'leave'
              };
            }
          };

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${newDmRoom._id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          assert.strictEqual(matrixBridge.getIntent().invite.callCount, 1);
          assert.deepEqual(matrixBridge.getIntent().invite.getCall(0).args[1], otherPersonMxid);
        });

        it('should invite Matrix user back to Matrix DM room if they were never in the room', async () => {
          const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            otherPersonMxid
          );
          await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

          // Stub the other user as left the room
          matrixBridge.getIntent().getStateEvent = (targetRoomId, type, stateKey) => {
            if (
              targetRoomId === matrixRoomId &&
              type === 'm.room.member' &&
              stateKey === otherPersonMxid
            ) {
              return null;
            }
          };

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${newDmRoom._id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          assert.strictEqual(matrixBridge.getIntent().invite.callCount, 1);
          assert.deepEqual(matrixBridge.getIntent().invite.getCall(0).args[1], otherPersonMxid);
        });

        it('should work if Matrix user already in DM room (not mess anything up)', async () => {
          const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            otherPersonMxid
          );
          await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

          // Stub the other user as already in the room
          matrixBridge.getIntent().getStateEvent = (targetRoomId, type, stateKey) => {
            if (
              targetRoomId === matrixRoomId &&
              type === 'm.room.member' &&
              stateKey === otherPersonMxid
            ) {
              return {
                membership: 'join'
              };
            }
          };

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${newDmRoom._id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          assert.strictEqual(matrixBridge.getIntent().invite.callCount, 0);
        });

        it('should still allow message to send if Matrix user failed to invite', async () => {
          const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
            fixture.user1,
            otherPersonMxid
          );
          await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

          // Stub the other user as left the room
          matrixBridge.getIntent().getStateEvent = (targetRoomId, type, stateKey) => {
            if (
              targetRoomId === matrixRoomId &&
              type === 'm.room.member' &&
              stateKey === otherPersonMxid
            ) {
              return {
                membership: 'leave'
              };
            }
          };

          // Force the invitation to fail!
          matrixBridge.getIntent().invite = () => Promise.reject('Fake failed to invite');

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${newDmRoom._id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          // Make sure the feedback warning message from the bridge user (@gitter-badger)
          // was sent in the Gitter room to let them know we had trouble inviting the Matrix
          // side back to the room.
          const messages = await chatService.findChatMessagesForTroupe(newDmRoom._id);
          assert.strictEqual(
            messages[0].text,
            `Unable to invite Matrix user back to DM room. They probably won't know about the message you just sent.`
          );

          // Message is still sent to the new room
          assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
          assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
            body: fixture.message1.text,
            format: 'org.matrix.custom.html',
            formatted_body: fixture.message1.html,
            msgtype: 'm.text'
          });
        });

        it('should not invite anyone for non-DM room', async () => {
          sinon.spy(gitterBridge, 'inviteMatrixUserToDmRoomIfNeeded');
          await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${fixture.troupe1.id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          // null means no invite was necessary for this room
          const inviteResult = await gitterBridge.inviteMatrixUserToDmRoomIfNeeded.firstCall
            .returnValue;
          assert.strictEqual(inviteResult, null);
        });

        it('messages from the bridge bot do not trigger invites to be sent out (avoid feedback loop)', async () => {
          await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
          // Pass in userBridge1 as the bridging user
          gitterBridge = new GitterBridge(matrixBridge, fixture.userBridge1.username);
          sinon.spy(gitterBridge, 'inviteMatrixUserToDmRoomIfNeeded');

          // Use a message from userBridge1
          serializedMessage = await restSerializer.serializeObject(
            fixture.messageFromBridgeBot1,
            strategy
          );

          await gitterBridge.onDataChange({
            type: 'chatMessage',
            url: `/rooms/${fixture.troupe1.id}/chatMessages`,
            operation: 'create',
            model: serializedMessage
          });

          assert.strictEqual(gitterBridge.inviteMatrixUserToDmRoomIfNeeded.callCount, 0);
        });
      });
    });

    describe('handleChatMessageEditEvent', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        userBridge1: {},
        group1: {},
        troupe1: {
          group: 'group1'
        },
        troupePrivate1: {
          group: 'group1',
          users: ['user1'],
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        },
        message1: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter message'
        },
        messageFromVirtualUser1: {
          user: 'userBridge1',
          virtualUser: {
            type: 'matrix',
            externalId: 'test-person:matrix.org',
            displayName: 'Tessa'
          },
          troupe: 'troupe1',
          text: 'my virtualUser message'
        },
        messagePrivate1: {
          user: 'user1',
          troupe: 'troupePrivate1',
          text: 'my private gitter message'
        }
      });

      it('edit message gets sent off to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        const serializedMessage = await restSerializer.serializeObject(fixture.message1, strategy);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'update',
          model: {
            ...serializedMessage,
            editedAt: new Date().toUTCString()
          }
        });

        // Message edit is sent off to Matrix
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);

        assert.deepEqual(matrixBridge.getIntent().sendMessage.getCall(0).args[1], {
          body: `* ${fixture.message1.text}`,
          format: 'org.matrix.custom.html',
          formatted_body: `* ${fixture.message1.html}`,
          msgtype: 'm.text',
          'm.new_content': {
            body: fixture.message1.text,
            format: 'org.matrix.custom.html',
            formatted_body: fixture.message1.html,
            msgtype: 'm.text'
          },
          'm.relates_to': {
            event_id: matrixMessageEventId,
            rel_type: 'm.replace'
          }
        });
      });

      it('message with same editedAt date is ignored', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        const serializedMessage = await restSerializer.serializeObject(fixture.message1, strategy);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'update',
          model: serializedMessage
        });

        // Message edit does not get sent to Matrix since it's already over there
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
      });

      it('non-bridged message that gets an edit is ignored', async () => {
        const serializedMessage = await restSerializer.serializeObject(fixture.message1, strategy);

        // We purposely do not associate the bridged message. We are testing that the
        // edit is ignored if there is no association in the database.
        //const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        //await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'update',
          model: serializedMessage
        });

        // Message edit is ignored if there isn't an associated bridge message
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
      });

      it('message edit from virtualUser is suppressed (no echo back and forth)', async () => {
        const serializedVirtualUserMessage = await restSerializer.serializeObject(
          fixture.messageFromVirtualUser1,
          strategy
        );

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(
          fixture.messageFromVirtualUser1,
          matrixRoomId,
          matrixMessageEventId
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'update',
          model: serializedVirtualUserMessage
        });

        // No message sent
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
      });

      it('edit in private room are bridged', async () => {
        const serializedMessage = await restSerializer.serializeObject(
          fixture.messagePrivate1,
          strategy
        );

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(
          fixture.messagePrivate1,
          matrixRoomId,
          matrixMessageEventId
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupePrivate1.id}/chatMessages`,
          operation: 'update',
          model: {
            ...serializedMessage,
            editedAt: new Date().toUTCString()
          }
        });

        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 1);
      });
    });

    describe('handleChatMessageRemoveEvent', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        userBridge1: {},
        group1: {},
        troupe1: {
          group: 'group1'
        },
        troupePrivate1: {
          group: 'group1',
          users: ['user1'],
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        },
        message1: {
          user: 'user1',
          troupe: 'troupe1',
          text: 'my gitter message'
        },
        messagePrivate1: {
          user: 'user1',
          troupe: 'troupePrivate1',
          text: 'my private gitter message'
        }
      });

      it('remove message gets sent off to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'remove',
          model: { id: fixture.message1.id }
        });

        // Message remove is sent off to Matrix
        assert.strictEqual(matrixBridge.getIntent().matrixClient.redactEvent.callCount, 1);
        assert.deepEqual(
          matrixBridge.getIntent().matrixClient.redactEvent.getCall(0).args[1],
          matrixMessageEventId
        );
      });

      it('non-bridged message that gets removed is ignored', async () => {
        // We purposely do not associate a bridged message. We are testing that the
        // remove is ignored if no association in the database.
        //const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        //await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'remove',
          model: { id: fixture.message1.id }
        });

        // Message remove is ignored if there isn't an associated bridge message
        assert.strictEqual(matrixBridge.getIntent().matrixClient.redactEvent.callCount, 0);
      });

      it('message remove in private room is bridged', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(
          fixture.messagePrivate1,
          matrixRoomId,
          matrixMessageEventId
        );

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupePrivate1.id}/chatMessages`,
          operation: 'remove',
          model: { id: fixture.messagePrivate1.id }
        });

        assert.strictEqual(matrixBridge.getIntent().matrixClient.redactEvent.callCount, 1);
      });

      it('when the Matrix API call to lookup the message author fails(`intent.getEvent()`), still deletes the message (using bridge user)', async () => {
        // Make the event lookup Matrix API call fail
        matrixBridge.getIntent().getEvent = () => {
          throw new Error('Fake error and failed to fetch event');
        };

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'remove',
          model: { id: fixture.message1.id }
        });

        // Message remove is sent off to Matrix
        assert.strictEqual(matrixBridge.getIntent().matrixClient.redactEvent.callCount, 1);
        assert.deepEqual(
          matrixBridge.getIntent().matrixClient.redactEvent.getCall(0).args[1],
          matrixMessageEventId
        );
      });

      it('when the Matrix API call to redact the message fails, still deletes the message (using bridge user)', async () => {
        // Make the event redaction Matrix API call fail
        let callCount = 0;
        matrixBridge.getIntent().matrixClient.redactEvent = sinon.spy(() => {
          // Only fail the first call
          if (callCount === 0) {
            callCount++;
            throw new Error('Fake error and failed to fetch event');
          }
        });

        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const matrixMessageEventId = `$${fixtureLoader.generateGithubId()}`;
        await store.storeBridgedMessage(fixture.message1, matrixRoomId, matrixMessageEventId);

        await gitterBridge.onDataChange({
          type: 'chatMessage',
          url: `/rooms/${fixture.troupe1.id}/chatMessages`,
          operation: 'remove',
          model: { id: fixture.message1.id }
        });

        // Message remove is sent off to Matrix
        assert.strictEqual(matrixBridge.getIntent().matrixClient.redactEvent.callCount, 2);
        assert.deepEqual(
          matrixBridge.getIntent().matrixClient.redactEvent.getCall(0).args[1],
          matrixMessageEventId
        );
      });
    });

    describe('handleRoomUpdateEvent', () => {
      const fixture = fixtureLoader.setupEach({
        group1: {},
        troupe1: {
          group: 'group1',
          topic: 'foo'
        },
        troupePrivate1: {
          group: 'group1',
          users: ['user1'],
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        }
      });

      it('room patch gets sent off to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupe1.id}`,
          operation: 'patch',
          model: { id: fixture.troupe1.id, topic: 'bar' }
        });

        // Find the spy call where the topic was updated
        const topicCall = matrixBridge
          .getIntent()
          .sendStateEvent.getCalls()
          .find(call => {
            const [mid, eventType] = call.args;
            if (mid === matrixRoomId && eventType === 'm.room.topic') {
              return true;
            }
          });
        assert.deepEqual(topicCall.args, [
          matrixRoomId,
          'm.room.topic',
          '',
          {
            // This value should really be 'bar' no worries, this is just a side-effect of mocking the `onDataChange`
            // instead of actually making an update to the room in the databse
            topic: 'foo'
          }
        ]);
      });

      it('private room patch is bridged', async () => {
        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupePrivate1.id}`,
          operation: 'patch',
          model: { id: fixture.troupePrivate1.id, topic: 'bar' }
        });

        const sendStateEventCalls = matrixBridge.getIntent().sendStateEvent.getCalls();
        assert(
          sendStateEventCalls.length > 0,
          `sendStateEvent was called ${sendStateEventCalls.length} times, expected at least 1 call`
        );
      });

      it('room update gets sent off to Matrix (same as patch)', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        const strategy = new restSerializer.TroupeStrategy();
        const serializedRoom = await restSerializer.serializeObject(fixture.troupe1, strategy);

        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupe1.id}`,
          operation: 'update',
          model: serializedRoom
        });

        const sendStateEventCalls = matrixBridge.getIntent().sendStateEvent.getCalls();
        assert(
          sendStateEventCalls.length > 0,
          `sendStateEvent was called ${sendStateEventCalls.length} times, expected at least 1 call`
        );
      });

      it('private room update is bridged', async () => {
        const strategy = new restSerializer.TroupeStrategy();
        const serializedRoom = await restSerializer.serializeObject(fixture.troupe1, strategy);

        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupePrivate1.id}`,
          operation: 'update',
          model: serializedRoom
        });

        const sendStateEventCalls = matrixBridge.getIntent().sendStateEvent.getCalls();
        assert(
          sendStateEventCalls.length > 0,
          `sendStateEvent was called ${sendStateEventCalls.length} times, expected at least 1 call`
        );
      });
    });

    describe('handleRoomRemoveEvent', () => {
      const fixture = fixtureLoader.setupEach({
        group1: {},
        troupe1: {
          group: 'group1',
          topic: 'foo'
        },
        troupePrivate1: {
          group: 'group1',
          users: ['user1'],
          securityDescriptor: {
            members: 'INVITE',
            admins: 'MANUAL',
            public: false
          }
        }
      });

      it('deleted Gitter room shuts down the room on the Matrix side', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupe1.id}`,
          operation: 'remove',
          model: { id: fixture.troupe1.id }
        });

        // Find the spy call where the join rules are changed so no one else can join
        const joinRuleCall = matrixBridge
          .getIntent()
          .sendStateEvent.getCalls()
          .find(call => {
            const [mid, eventType] = call.args;
            if (mid === matrixRoomId && eventType === 'm.room.join_rules') {
              return true;
            }
          });
        assert.deepEqual(joinRuleCall.args, [
          matrixRoomId,
          'm.room.join_rules',
          '',
          {
            join_rule: 'invite'
          }
        ]);
      });
    });

    describe('handleUserJoiningRoom', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        troupe1: {},

        userAdmin1: {},
        troupeWithAdmin1: {
          users: ['user1'],
          securityDescriptor: {
            type: null,
            members: 'PUBLIC',
            admins: 'MANUAL',
            public: true,
            extraAdmins: ['userAdmin1']
          }
        }
      });

      it('user join membership syncs to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const mxidForGitterUser = getMxidForGitterUser(fixture.user1);

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupe1.id}/users`,
          operation: 'create',
          model: { id: fixture.user1.id }
        });

        assert.strictEqual(
          matrixBridge.getIntent.callCount,
          3,
          `Expected callCount does not match actual:\n` +
            matrixBridge.getIntent
              .getCalls()
              .map((call, index) => `${index}: getIntent(${call.args.join(', ')})`)
              .join('\n')
        );
        assert.strictEqual(matrixBridge.getIntent.getCall(2).args[0], mxidForGitterUser);
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().join.getCall(0).args[0], matrixRoomId);
      });

      it(`user join is ignored when the Matrix room isn't created yet`, async () => {
        // This is commented out on purpose, we are testing that the join is ignored
        // when the Matrix room hasn't been created yet.
        //await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupe1.id}/users`,
          operation: 'create',
          model: { id: fixture.user1.id }
        });

        assert.strictEqual(matrixBridge.getIntent().join.callCount, 0);
      });

      it('no action occurs when user join fails for normal room', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        // Make the event lookup Matrix API call fail
        matrixBridge.getIntent().join = () => {
          throw new Error('Failed to join room');
        };

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupe1.id}/users`,
          operation: 'create',
          model: { id: fixture.user1.id }
        });

        // No room creation
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 0);
      });

      it('new Matrix DM created when user join fails for DM room', async () => {
        const otherPersonMxid = '@alice:localhost';
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        const newDmRoom = await gitterUtils.getOrCreateGitterDmRoomByGitterUserAndOtherPersonMxid(
          fixture.user1,
          otherPersonMxid
        );
        await store.storeBridgedRoom(newDmRoom._id, matrixRoomId);

        // Make the event lookup Matrix API call fail
        matrixBridge.getIntent().join = () => {
          throw new Error('Failed to join room');
        };

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${newDmRoom._id}/users`,
          operation: 'create',
          model: { id: fixture.user1.id }
        });

        // New DM room is created
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 1);
        assert.deepEqual(matrixBridge.getIntent().createRoom.getCall(0).args[0], {
          createAsClient: true,
          options: {
            visibility: 'private',
            preset: 'trusted_private_chat',
            is_direct: true,
            invite: [otherPersonMxid]
          }
        });
      });

      it('admin joining room syncs power levels to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupeWithAdmin1.id, matrixRoomId);
        const mxidForGitterUser = getMxidForGitterUser(fixture.userAdmin1);

        // Stub the some power levels
        matrixBridge.getIntent().getStateEvent = (targetRoomId, type, stateKey) => {
          if (
            targetRoomId === matrixRoomId &&
            type === 'm.room.power_levels' &&
            stateKey === undefined
          ) {
            return {
              // events_default: 0,
              // users_default: 0,
              // state_default: 50,
              users: {}
            };
          }
        };

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupeWithAdmin1.id}/users`,
          operation: 'create',
          model: { id: fixture.userAdmin1.id }
        });

        // Make sure we're only working with the bridge intent or the user in question
        const expectedMxidsWithIntent = [
          // bridge intent
          undefined,
          // MXID for the user in question
          mxidForGitterUser
        ];
        const actualMxidsWithIntent = matrixBridge.getIntent.getCalls().map(call => call.args[0]);
        assert(
          actualMxidsWithIntent.every(mxidWeGotIntentFor => {
            return expectedMxidsWithIntent.includes(mxidWeGotIntentFor);
          }),
          `Expected to only call \`getIntent(...)\` with one of these MXIDs=${JSON.stringify(
            expectedMxidsWithIntent
          )} but received these calls where at least one does not match:\n${actualMxidsWithIntent
            .map((mxid, index) => `${index}: ${mxid}`)
            .join('\n')}`
        );

        // Assert that the user is joined to the room on Matrix
        assert.strictEqual(matrixBridge.getIntent().join.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().join.getCall(0).args[0], matrixRoomId);
        // Assert that the admin power level is sent
        assert.strictEqual(matrixBridge.getIntent().sendStateEvent.callCount, 1);
        const sendPowerLevelStateEventCall = matrixBridge.getIntent().sendStateEvent.getCall(0);
        assert(sendPowerLevelStateEventCall);
        assert.deepEqual(sendPowerLevelStateEventCall.args, [
          matrixRoomId,
          'm.room.power_levels',
          '',
          {
            users: {
              [mxidForGitterUser]: ROOM_ADMIN_POWER_LEVEL
            }
          }
        ]);
      });
    });

    describe('handleUserLeavingRoom', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        troupe1: {}
      });

      it('user leave membership syncs to Matrix', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const mxidForGitterUser = getMxidForGitterUser(fixture.user1);

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupe1.id}/users`,
          operation: 'remove',
          model: { id: fixture.user1.id }
        });

        assert.strictEqual(matrixBridge.getIntent.callCount, 3);
        assert.strictEqual(matrixBridge.getIntent.getCall(2).args[0], mxidForGitterUser);
        assert.strictEqual(matrixBridge.getIntent().leave.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().leave.getCall(0).args[0], matrixRoomId);
      });

      it(`user leave is ignored when the Matrix room isn't created yet`, async () => {
        // This is commented out on purpose, we are testing that the leave is ignored
        // when the Matrix room hasn't been created yet.
        //await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'user',
          url: `/rooms/${fixture.troupe1.id}/users`,
          operation: 'remove',
          model: { id: fixture.user1.id }
        });

        assert.strictEqual(matrixBridge.getIntent().leave.callCount, 0);
      });
    });

    describe('handleRoomBanEvent', () => {
      const fixture = fixtureLoader.setupEach({
        user1: {},
        troupe1: {}
      });

      it('bridges ban for Gitter user', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const mxidForGitterUser = getMxidForGitterUser(fixture.user1);

        await gitterBridge.onDataChange({
          type: 'ban',
          url: `/rooms/${fixture.troupe1.id}/bans`,
          operation: 'create',
          model: { userId: fixture.user1.id }
        });

        assert.strictEqual(matrixBridge.getIntent().ban.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().ban.getCall(0).args[0], matrixRoomId);
        assert.strictEqual(matrixBridge.getIntent().ban.getCall(0).args[1], mxidForGitterUser);
      });

      it('bridges unban for Gitter user', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);
        const mxidForGitterUser = getMxidForGitterUser(fixture.user1);

        await gitterBridge.onDataChange({
          type: 'ban',
          url: `/rooms/${fixture.troupe1.id}/bans`,
          operation: 'remove',
          model: { userId: fixture.user1.id }
        });

        assert.strictEqual(matrixBridge.getIntent().unban.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().unban.getCall(0).args[0], matrixRoomId);
        assert.strictEqual(matrixBridge.getIntent().unban.getCall(0).args[1], mxidForGitterUser);
      });

      it('bridges ban for virtualUser', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'ban',
          url: `/rooms/${fixture.troupe1.id}/bans`,
          operation: 'create',
          model: {
            virtualUser: {
              type: 'matrix',
              externalId: 'bad-guy:matrix.org'
            }
          }
        });

        assert.strictEqual(matrixBridge.getIntent().ban.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().ban.getCall(0).args[0], matrixRoomId);
        assert.strictEqual(matrixBridge.getIntent().ban.getCall(0).args[1], '@bad-guy:matrix.org');
      });

      it('bridges unban for virtualUser', async () => {
        const matrixRoomId = `!${fixtureLoader.generateGithubId()}:localhost`;
        await store.storeBridgedRoom(fixture.troupe1.id, matrixRoomId);

        await gitterBridge.onDataChange({
          type: 'ban',
          url: `/rooms/${fixture.troupe1.id}/bans`,
          operation: 'remove',
          model: {
            virtualUser: {
              type: 'matrix',
              externalId: 'bad-guy:matrix.org'
            }
          }
        });

        assert.strictEqual(matrixBridge.getIntent().unban.callCount, 1);
        assert.strictEqual(matrixBridge.getIntent().unban.getCall(0).args[0], matrixRoomId);
        assert.strictEqual(
          matrixBridge.getIntent().unban.getCall(0).args[1],
          '@bad-guy:matrix.org'
        );
      });
    });
  });
});
