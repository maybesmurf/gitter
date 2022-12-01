'use strict';

const assert = require('assert');
const TestError = require('gitter-web-test-utils/lib/test-error');
const unsubscribeHashes = require('../lib/unsubscribe-hashes');

describe('unsubscribe-hashs', () => {
  it('should be able to decipher something it created', () => {
    const expectedUserId = '999996666699999';
    const expectedNotificationType = 'unread_notifications';

    const hash = unsubscribeHashes.createHash(expectedUserId, expectedNotificationType);

    const { userId, notificationType } = unsubscribeHashes.decipherHash(hash);
    assert.strictEqual(userId, expectedUserId);
    assert.strictEqual(notificationType, expectedNotificationType);
  });

  it('will throw when you forget the userId', () => {
    try {
      unsubscribeHashes.createHash(null, 'unread_notifications');
      assert.fail(
        new TestError('we expect an error to be thrown instead of returning a empty hash')
      );
    } catch (err) {
      if (err instanceof TestError) {
        throw err;
      }

      assert(err);
    }
  });

  it('will throw when you forget the notificationType', () => {
    try {
      unsubscribeHashes.createHash('999996666699999', null);
      assert.fail(
        new TestError('we expect an error to be thrown instead of returning a empty hash')
      );
    } catch (err) {
      if (err instanceof TestError) {
        throw err;
      }

      assert(err);
    }
  });
});
