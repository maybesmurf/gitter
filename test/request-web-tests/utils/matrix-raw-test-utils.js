'use strict';

const assert = require('assert');
const util = require('util');
const requestLib = util.promisify(require('request'));
const urlJoin = require('url-join');

const env = require('gitter-web-env');
const config = env.config;

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');

async function joinMatrixRoom(matrixRoomId, matrixAccessToken) {
  assert(matrixRoomId);
  assert(matrixAccessToken);
  const joinRes = await requestLib({
    method: 'POST',
    uri: urlJoin(homeserverUrl, `/_matrix/client/r0/rooms/${matrixRoomId}/join`),
    json: true,
    headers: {
      Authorization: `Bearer ${matrixAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: {}
  });

  return joinRes;
}

async function getMessagesFromMatrixRoom({ matrixRoomId, matrixAccessToken, dir, limit }) {
  assert(matrixRoomId);
  assert(matrixAccessToken);
  assert(dir);
  assert(limit);
  let qs = new URLSearchParams();
  qs.append('dir', dir);
  qs.append('limit', limit);

  const messagesRes = await requestLib({
    method: 'GET',
    uri: urlJoin(
      homeserverUrl,
      `/_matrix/client/r0/rooms/${matrixRoomId}/messages?${qs.toString()}`
    ),
    json: true,
    headers: {
      Authorization: `Bearer ${matrixAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: {}
  });

  return messagesRes;
}

module.exports = {
  joinMatrixRoom,
  getMessagesFromMatrixRoom
};
