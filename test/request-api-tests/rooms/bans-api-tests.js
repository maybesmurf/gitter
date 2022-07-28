'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';

const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const assert = require('assert');

const troupeService = require('gitter-web-rooms/lib/troupe-service');

describe('bans-api', function() {
  let app, request;

  fixtureLoader.ensureIntegrationEnvironment('#oauthTokens');

  before(function() {
    if (this._skipFixtureSetup) return;

    request = require('supertest');
    app = require('../../../server/api');
  });

  describe('POST /v1/rooms/:roomId/bans', () => {
    const banFixtures = fixtureLoader.setup({
      user1: {
        accessToken: 'web-internal'
      },
      userAdmin1: {
        accessToken: 'web-internal'
      },
      userToBan1: {
        accessToken: 'web-internal'
      },
      troupe1: {
        securityDescriptor: {
          extraAdmins: ['userAdmin1']
        }
      }
    });

    it('Normal user not allowed to ban people', () => {
      return request(app)
        .post(`/v1/rooms/${banFixtures.troupe1.id}/bans`)
        .send({
          username: banFixtures.userToBan1.username
        })
        .set('x-access-token', banFixtures.user1.accessToken)
        .expect(403);
    });

    it('Ban normal user', () => {
      return request(app)
        .post(`/v1/rooms/${banFixtures.troupe1.id}/bans`)
        .send({
          username: banFixtures.userToBan1.username
        })
        .set('x-access-token', banFixtures.userAdmin1.accessToken)
        .expect(200);
    });

    it('ban virtualUser via username', () => {
      return request(app)
        .post(`/v1/rooms/${banFixtures.troupe1.id}/bans`)
        .send({
          username: 'bad-guy:matrix.org'
        })
        .set('x-access-token', banFixtures.userAdmin1.accessToken)
        .expect(200)
        .then(function(result) {
          const body = result.body;
          assert(body.virtualUser);
        });
    });

    it('ban virtualUser via object', () => {
      return request(app)
        .post(`/v1/rooms/${banFixtures.troupe1.id}/bans`)
        .send({
          virtualUser: {
            type: 'matrix',
            externalId: 'bad-guy:matrix.org'
          }
        })
        .set('x-access-token', banFixtures.userAdmin1.accessToken)
        .expect(200)
        .then(function(result) {
          const body = result.body;
          assert(body.virtualUser);
        });
    });
  });

  describe('DELETE /v1/rooms/:roomId/bans', () => {
    const unbanfixtures = fixtureLoader.setup({
      user1: { accessToken: 'web-internal' },
      userAdmin1: { accessToken: 'web-internal' },
      userBanned1: { accessToken: 'web-internal' },
      userBanned2: { accessToken: 'web-internal' },
      userBanned3: { accessToken: 'web-internal' },
      troupeWithBannedUsers1: {
        securityDescriptor: {
          extraAdmins: ['userAdmin1']
        },
        bans: [
          {
            user: 'userBanned1',
            dateBanned: Date.now(),
            bannedBy: 'userAdmin1'
          },
          {
            user: 'userBanned2',
            dateBanned: Date.now(),
            bannedBy: 'userAdmin1'
          },
          {
            user: 'userBanned3',
            dateBanned: Date.now(),
            bannedBy: 'userAdmin1'
          }
        ]
      },
      troupeWithBannedVirtualUsers1: {
        securityDescriptor: {
          extraAdmins: ['userAdmin1']
        },
        bans: [
          {
            virtualUser: {
              type: 'matrix',
              externalId: 'user-banned1:matrix.org'
            },
            dateBanned: new Date('1995-12-17T03:24:00+00:00'),
            bannedBy: 'userAdmin1'
          },
          {
            virtualUser: {
              type: 'matrix',
              externalId: 'user-banned2:matrix.org'
            },
            dateBanned: new Date('1995-12-17T03:24:00+00:00'),
            bannedBy: 'userAdmin1'
          },
          {
            virtualUser: {
              type: 'matrix',
              externalId: 'user-banned3:matrix.org'
            },
            dateBanned: new Date('1995-12-17T03:24:00+00:00'),
            bannedBy: 'userAdmin1'
          }
        ]
      }
    });

    it('Normal user not allowed to unban people', () => {
      return request(app)
        .delete(
          `/v1/rooms/${unbanfixtures.troupeWithBannedUsers1.id}/bans/${unbanfixtures.userBanned2.username}`
        )
        .set('x-access-token', unbanfixtures.user1.accessToken)
        .expect(403);
    });

    it('Unban normal user', async () => {
      const userIdToUserKeyMap = {};
      ['user1', 'userAdmin1', 'userBanned1', 'userBanned2', 'userBanned3'].forEach(userKey => {
        userIdToUserKeyMap[unbanfixtures[userKey].id] = userKey;
      });

      await request(app)
        .delete(
          `/v1/rooms/${unbanfixtures.troupeWithBannedUsers1.id}/bans/${unbanfixtures.userBanned2.username}`
        )
        .set('x-access-token', unbanfixtures.userAdmin1.accessToken)
        .expect(200);

      const updatedRoom = await troupeService.findById(unbanfixtures.troupeWithBannedUsers1.id);
      // Make sure `userBanned2` is no longer banned and the rest
      // of the users remain banned.
      assert.deepEqual(updatedRoom.bans.map(ban => userIdToUserKeyMap[ban.userId]), [
        'userBanned1',
        'userBanned3'
      ]);
    });

    it('Unban virtualUser', async () => {
      // Make sure we're testing with at least 3 users so we don't regress
      // https://gitlab.com/gitterHQ/webapp/-/issues/2848 and unban the wrong
      // person.
      assert.strictEqual(unbanfixtures.troupeWithBannedVirtualUsers1.bans.length, 3);
      // We use the middle ban so we can assert that it specifically was removed instead of
      // the first or last ban accidentally.
      const mxidToUnnan =
        unbanfixtures.troupeWithBannedVirtualUsers1.bans[1].virtualUser.externalId;

      await request(app)
        .delete(`/v1/rooms/${unbanfixtures.troupeWithBannedVirtualUsers1.id}/bans/${mxidToUnnan}`)
        .set('x-access-token', unbanfixtures.userAdmin1.accessToken)
        .expect(200);

      const updatedRoom = await troupeService.findById(
        unbanfixtures.troupeWithBannedVirtualUsers1.id
      );
      // Make sure `user-banned2:matrix.org` is no longer banned and the rest
      // of the users remain banned.
      assert.deepEqual(updatedRoom.bans.map(ban => ban.virtualUser.externalId), [
        'user-banned1:matrix.org',
        'user-banned3:matrix.org'
      ]);
    });
  });
});
