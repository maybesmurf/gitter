'use strict';

const assert = require('assert');
const crypto = require('crypto');

const env = require('gitter-web-env');
const config = env.config;
const passphrase = config.get('email:unsubscribeNotificationsSecret');

function createHash(userId, notificationType) {
  assert(userId);
  assert(notificationType);

  const plaintext = `${userId},${notificationType}`;
  const cipher = crypto.createCipher('aes256', passphrase);
  const hash = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');

  return hash;
}

function decipherHash(hash) {
  const decipher = crypto.createDecipher('aes256', passphrase);
  const plaintext = decipher.update(hash, 'hex', 'utf8') + decipher.final('utf8');

  const parts = plaintext.split(',');
  const userId = parts[0];
  const notificationType = parts[1];

  return {
    userId,
    notificationType
  };
}

module.exports = {
  createHash,
  decipherHash
};
