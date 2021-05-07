'use strict';

const assert = require('assert');
const util = require('util');
const crypto = require('crypto');
const request = util.promisify(require('request'));
const urlJoin = require('url-join');

const env = require('gitter-web-env');
const config = env.config;

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
assert(homeserverUrl, 'matrix:bridge:homeserverUrl must be defined');
const testSynapseRegistrationSharedSecret = config.get(
  'matrix:bridge:testSynapseRegistrationSharedSecret'
);
assert(
  testSynapseRegistrationSharedSecret,
  'matrix:bridge:testSynapseRegistrationSharedSecret must be defined'
);

// This is based on https://github.com/matrix-org/synapse/blob/4d624f467a6c252b9295e46b8b83f36b1f0d3d45/synapse/_scripts/register_new_matrix_user.py#L27-L91
// Also see https://github.com/matrix-org/synapse/blob/develop/docs/admin_api/user_admin_api.rst#create-or-modify-account
async function registerTestSynapseUser(localPart) {
  const registerUrl = urlJoin(homeserverUrl, `/_synapse/admin/v1/register`);

  const registerGetRes = await request({
    method: 'GET',
    uri: registerUrl,
    json: true,
    headers: {
      'Content-Type': 'application/json'
    },
    body: {}
  });

  if (registerGetRes.statusCode !== 200) {
    throw new Error(
      `registerTestSynapseUser failed to fetch nonce, localPart=${localPart} statusCode=${
        registerGetRes.statusCode
      }, body=${JSON.stringify(registerGetRes.body)}`
    );
  }

  const nonce = registerGetRes.body.nonce;
  assert(nonce);

  const admin = false;
  const password = crypto.randomBytes(20).toString('hex');

  let mac = crypto
    .createHmac('sha1', testSynapseRegistrationSharedSecret)
    .update(nonce)
    .update('\x00')
    .update(localPart)
    .update('\x00')
    .update(password)
    .update('\x00')
    .update(admin ? 'admin' : 'notadmin')
    //.update("\x00")
    //.update(toUtf8(user_type))
    .digest('hex');

  const userCreateRes = await request({
    method: 'POST',
    uri: registerUrl,
    json: true,
    headers: {
      'Content-Type': 'application/json'
    },
    body: {
      nonce: nonce,
      username: localPart,
      password: password,
      mac: mac,
      admin: false
      //user_type: user_type
    }
  });

  if (userCreateRes.statusCode < 200 || userCreateRes.statusCode >= 300) {
    throw new Error(
      `registerTestSynapseUser failed to create user, localPart=${localPart} statusCode=${
        userCreateRes.statusCode
      }, body=${JSON.stringify(userCreateRes.body)}`
    );
  }

  return userCreateRes.body;
}

module.exports = registerTestSynapseUser;
