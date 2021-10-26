'use strict';

const env = require('gitter-web-env');
const config = env.config;

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');

// Based off of https://github.com/matrix-org/matrix-bifrost/blob/c7161dd998c4fe968dba4d5da668dc914248f260/src/MessageFormatter.ts#L45-L60
function mxcUrlToHttp(mxcUrl) {
  const uriBits = mxcUrl.substr('mxc://'.length).split('/');
  const url = homeserverUrl.replace(/\/$/, '');
  return `${url}/_matrix/media/v1/download/${uriBits[0]}/${uriBits[1]}`;
}

module.exports = mxcUrlToHttp;
