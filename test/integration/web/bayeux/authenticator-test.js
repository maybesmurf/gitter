'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const testRequire = require('../../test-require');
const makeRequest = require('../../make-request');

const authenticator = testRequire('./web/bayeux/authenticator');

const REQ_STUB = makeRequest(
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:47.0) Gecko/20100101 Firefox/47.0'
);

describe('authenticator', () => {
  const fixture = fixtureLoader.setupEach({
    user1: {
      accessToken: 'web-internal'
    }
  });

  it('callback is only called once on success', done => {
    const message = {
      channel: '/meta/handshake',
      ext: {
        token: fixture.user1.accessToken
      }
    };

    authenticator.incoming(message, REQ_STUB, function(message) {
      assert(message);
      assert.strictEqual(message.error, undefined, 'We should not see any error for a success');
      // And `done` should only be called once (test will error done called multiple times)
      done();
    });
  });

  it('callback is only called once on error', done => {
    const message = {
      channel: '/meta/handshake',
      ext: {
        token: '0000000000000000000000000000000000000000'
      }
    };

    authenticator.incoming(message, REQ_STUB, function(message) {
      assert(message.error, 'Expected error');
      // And `done` should only be called once (test will error done called multiple times)
      done();
    });
  });

  describe('Errors in logs', () => {
    const loggerErrorSpy = sinon.spy();
    const authenticatorWithStubbedLogger = testRequire.withProxies('./web/bayeux/authenticator', {
      './extension': testRequire.withProxies('./web/bayeux/extension', {
        'gitter-web-env': {
          ...testRequire('gitter-web-env'),
          logger: {
            error: loggerErrorSpy
          }
        }
      })
    });

    it('Invalid token error is not logged', done => {
      const message = {
        channel: '/meta/handshake',
        ext: {
          token: '0000000000000000000000000000000000000000'
        }
      };

      authenticatorWithStubbedLogger.incoming(message, REQ_STUB, function(message) {
        assert(message.error, 'Expected an invalid token error');
        // Make sure the logger is not called
        assert.strictEqual(loggerErrorSpy.callCount, 0);
        done();
      });
    });

    it('Required token error is not logged', done => {
      const message = {
        channel: '/meta/handshake',
        ext: {}
      };

      authenticatorWithStubbedLogger.incoming(message, REQ_STUB, function(message) {
        assert(message.error, 'Expected an invalid token error');
        // Make sure the logger is not called
        assert.strictEqual(loggerErrorSpy.callCount, 0);
        done();
      });
    });
  });
});
