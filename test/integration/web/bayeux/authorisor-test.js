'use strict';

var testRequire = require('../../test-require');
const makeRequest = require('../../make-request');
var assert = require('assert');
const sinon = require('sinon');
var Promise = require('bluebird');
var testGenerator = require('gitter-web-test-utils/lib/test-generator');

var mockito = require('jsmockito').JsMockito;

const REQ_STUB = makeRequest(
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:47.0) Gecko/20100101 Firefox/47.0'
);

describe('authorisor', function() {
  describe('incoming', function() {
    // All of our fixtures
    var FIXTURES = [
      {
        name: 'Subscribe, socket does not exist',
        meta: {
          socketExists: false,
          clientId: 'y',
          expectedError: true
        }
      },
      {
        name: 'socket exists',
        meta: {
          socketExists: true,
          clientId: 'x',
          userId: '53d8a945451e506ad636c9ba',
          token: 'myToken'
        },
        tests: [
          {
            name: 'room subscription',
            meta: {
              troupeId: '53d8a7145be4af565d856e6e',
              subscription: '/api/v1/rooms/53d8a7145be4af565d856e6e'
            },
            tests: [
              {
                name: 'has access',
                canAccessRoom: true
              },
              {
                name: 'has no access',
                canAccessRoom: false,
                expectedError: true
              }
            ]
          },
          {
            name: 'user subscription (own userId)',
            meta: {
              subscription: '/api/v1/user/53d8a945451e506ad636c9ba'
            }
          },
          {
            name: 'user subscription (another userId)',
            meta: {
              subscription: '/api/v1/user/53d8aa12d795e2ab8be23550', // different
              expectedError: true // Access denied
            }
          },
          {
            name: 'token subscription (own token)',
            meta: {
              subscription: '/api/v1/token/myToken'
            }
          },
          {
            name: 'token subscription (another users token)',
            meta: {
              subscription: '/api/v1/token/anotherUsersToken',
              expectedError: true // Access denied
            }
          }
        ]
      }
    ];

    testGenerator(FIXTURES, function(name, meta) {
      var presenceServiceMock = mockito.mock(testRequire('gitter-web-presence'));
      var restfulMock = mockito.mock(testRequire('./services/restful'));
      var createPolicyForUserIdInRoomId = mockito.mockFunction();

      mockito
        .when(createPolicyForUserIdInRoomId)()
        .then(function(userId, roomId) {
          if (meta.canAccessRoom !== true && meta.canAccessRoom !== false) {
            assert(false, 'Unexpected call to canAccessRoom');
          }

          assert.equal(userId, meta.userId);
          assert.equal(roomId, meta.troupeId);

          return Promise.resolve({
            canRead: function() {
              return Promise.resolve(!!meta.canAccessRoom);
            }
          });
        });

      var authorisor = testRequire.withProxies('./web/bayeux/authorisor', {
        'gitter-web-permissions/lib/policy-factory': {
          createPolicyForUserIdInRoomId: createPolicyForUserIdInRoomId
        },
        'gitter-web-presence': presenceServiceMock,
        '../../services/restful': restfulMock,
        'gitter-web-oauth/lib/tokens': {
          validateToken: token => {
            if (token === meta.token) {
              return Promise.resolve([meta.userId, meta.clientId]);
            } else {
              return Promise.resolve(null);
            }
          }
        }
      });

      it(name, function(done) {
        var message = {
          channel: '/meta/subscribe',
          clientId: meta.clientId,
          subscription: meta.subscription
        };

        mockito
          .when(presenceServiceMock)
          .lookupUserIdForSocket()
          .then(function(clientId) {
            assert.equal(clientId, meta.clientId);
            if (!meta.socketExists) return Promise.resolve([null, false]);

            return Promise.resolve([meta.userId, true]);
          });

        mockito
          .when(presenceServiceMock)
          .socketReassociated()
          .then((clientId, userId, troupeId) => {
            assert.equal(clientId, meta.clientId);
            assert.equal(userId, meta.userId);
            assert.equal(troupeId, meta.troupeId);
            return Promise.resolve();
          });

        authorisor.incoming(message, null, function(message) {
          if (meta.expectedError) {
            assert(!!message.error, 'Expected an error');
            done();
          } else {
            done(message.error);
          }
        });
      });
    });
  });

  describe('Errors in logs', () => {
    const loggerErrorSpy = sinon.spy();
    const presenceService = testRequire('gitter-web-presence');
    const authorisorWithStubbedLogger = testRequire.withProxies('./web/bayeux/authorisor', {
      './extension': testRequire.withProxies('./web/bayeux/extension', {
        'gitter-web-env': {
          ...testRequire('gitter-web-env'),
          logger: {
            error: loggerErrorSpy
          }
        }
      }),
      'gitter-web-presence': {
        ...presenceService,
        lookupUserIdForSocket: clientId => {
          // Add a way for something to go wrong with the app
          // so we can test whether we can still log an unknown app error
          if (clientId === 'TEST_THROW_AN_ERROR') {
            return Promise.reject(new Error('FAKE ERROR thrown in presence service'));
          }

          return presenceService.lookupUserIdForSocket(clientId);
        }
      }
    });

    beforeEach(() => {
      loggerErrorSpy.resetHistory();
    });

    it('Client not found error is not logged', done => {
      const message = {
        channel: '/meta/subscribe',
        clientId: '0000000000000000000000000000000000000000'
      };

      authorisorWithStubbedLogger.incoming(message, REQ_STUB, function(message) {
        assert(
          message.error,
          `Expected a client not found error in message.error\nmessage=${JSON.stringify(
            message,
            null,
            2
          )}`
        );
        // Make sure the logger is not called
        assert.strictEqual(loggerErrorSpy.callCount, 0);
        done();
      });
    });

    it('socketId expected error is not logged', done => {
      const message = {
        channel: '/meta/subscribe',
        clientId: null
      };

      authorisorWithStubbedLogger.incoming(message, REQ_STUB, function(message) {
        assert(
          message.error,
          `Expected a socketId expected error in message.error\nmessage=${JSON.stringify(
            message,
            null,
            2
          )}`
        );
        // Make sure the logger is not called
        assert.strictEqual(loggerErrorSpy.callCount, 0);
        done();
      });
    });

    // This is making sure our `ignoreErrorsInLogging` logic isn't ignoring all errors
    it('Make sure logging in general still works outside of the ignored errors', done => {
      const message = {
        channel: '/meta/subscribe',
        // Use the special clientId we define in the stub above to cause an app error to be thrown
        clientId: 'TEST_THROW_AN_ERROR'
      };

      authorisorWithStubbedLogger.incoming(message, null, function(message) {
        assert(
          message.error,
          `Expected message.error\nmessage=${JSON.stringify(message, null, 2)}`
        );
        // Make sure the logger is called
        assert.strictEqual(loggerErrorSpy.callCount, 1);
        done();
      });
    });
  });
});
