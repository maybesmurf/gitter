'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const restSerializer = require('../../../server/serializers/rest-serializer');
const GitterBridge = require('../lib/gitter-bridge');
const GitterUtils = require('../lib/gitter-utils');
const store = require('../lib/store');

const strategy = new restSerializer.ChatStrategy();

describe('gitter-bridge', () => {
  const overallFixtures = fixtureLoader.setupEach({
    userBridge1: {},
    group1: {}
  });

  let gitterBridge;
  let matrixBridge;
  let gitterUtils;
  beforeEach(() => {
    const clientSpies = {
      redactEvent: sinon.spy(),
      getRoomIdForAlias: sinon.spy(),
      deleteAlias: sinon.spy(),
      getRoomDirectoryVisibility: sinon.spy(),
      setRoomDirectoryVisibility: sinon.spy()
    };

    const intentSpies = {
      getClient: () => clientSpies,
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
      setDisplayName: sinon.spy(),
      uploadContent: sinon.spy(),
      setAvatarUrl: sinon.spy(),
      getRoomDirectoryVisibility: sinon.spy(),
      setRoomDirectoryVisibility: sinon.spy(),
      invite: sinon.spy()
    };

    matrixBridge = {
      getIntent: (/*userId*/) => intentSpies
    };

    gitterBridge = new GitterBridge(matrixBridge, overallFixtures.userBridge1.username);

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

      it('private room is not bridged', async () => {
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

        // No room creation
        assert.strictEqual(matrixBridge.getIntent().createRoom.callCount, 0);
        // No message sent
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
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

      it('private room is not bridged', async () => {
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
          model: serializedMessage
        });

        // No message sent
        assert.strictEqual(matrixBridge.getIntent().sendMessage.callCount, 0);
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
        assert.strictEqual(matrixBridge.getIntent().getClient().redactEvent.callCount, 1);
        assert.deepEqual(
          matrixBridge
            .getIntent()
            .getClient()
            .redactEvent.getCall(0).args[1],
          matrixMessageEventId
        );
      });

      it('non-bridged message that gets removed is ignored', async () => {
        // We purposely do not associate bridged message. We are testing that the
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
        assert.strictEqual(matrixBridge.getIntent().getClient().redactEvent.callCount, 0);
      });

      it('private room is not bridged', async () => {
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
          model: { id: fixture.message1.id }
        });

        // Message remove is ignored in private rooms
        assert.strictEqual(matrixBridge.getIntent().getClient().redactEvent.callCount, 0);
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
        assert.strictEqual(matrixBridge.getIntent().getClient().redactEvent.callCount, 1);
        assert.deepEqual(
          matrixBridge
            .getIntent()
            .getClient()
            .redactEvent.getCall(0).args[1],
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

      it('private room patch is not bridged', async () => {
        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupePrivate1.id}`,
          operation: 'patch',
          model: { id: fixture.troupePrivate1.id, topic: 'bar' }
        });

        // No room updates propagated across
        assert.strictEqual(matrixBridge.getIntent().sendStateEvent.callCount, 0);
      });

      it('room update gets sent off to Matrix', async () => {
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

        // Find the spy call where the topic was updated

        const sendStateEventCalls = matrixBridge.getIntent().sendStateEvent.getCalls();
        assert(
          sendStateEventCalls.length > 0,
          `sendStateEvent was called ${sendStateEventCalls.length} times, expected at least 1 call`
        );
      });

      it('private room update is not bridged', async () => {
        const strategy = new restSerializer.TroupeStrategy();
        const serializedRoom = await restSerializer.serializeObject(fixture.troupe1, strategy);

        await gitterBridge.onDataChange({
          type: 'room',
          url: `/rooms/${fixture.troupePrivate1.id}`,
          operation: 'update',
          model: serializedRoom
        });

        // No room updates propagated across
        assert.strictEqual(matrixBridge.getIntent().sendStateEvent.callCount, 0);
      });
    });
  });
});
