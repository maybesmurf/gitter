'use strict';

const assert = require('assert');
const env = require('gitter-web-env');
const config = env.config;

const parseGitterMxid = require('../lib/parse-gitter-mxid');
const getMxidForGitterUser = require('../lib/get-mxid-for-gitter-user');

const configuredServerName = config.get('matrix:bridge:serverName');

describe('parseGitterMxid', () => {
  [
    {
      name: 'works on basic username',
      mxid: getMxidForGitterUser({
        id: '553d437215522ed4b3df8c50',
        username: 'myuser'
      }),
      expectedResult: {
        username: 'myuser',
        userId: '553d437215522ed4b3df8c50',
        serverName: configuredServerName
      }
    },
    {
      name: 'works on hyphenated username',
      mxid: getMxidForGitterUser({
        id: '553d437215522ed4b3df8c50',
        username: 'some-random-user'
      }),
      expectedResult: {
        username: 'some-random-user',
        userId: '553d437215522ed4b3df8c50',
        serverName: configuredServerName
      }
    },
    {
      name: 'works with hypens and hex characters that appear like Mongo Object ID',
      mxid: getMxidForGitterUser({
        id: '553d437215522ed4b3df8c50',
        username: 'some-abcde-user'
      }),
      expectedResult: {
        username: 'some-abcde-user',
        userId: '553d437215522ed4b3df8c50',
        serverName: configuredServerName
      }
    },
    {
      name: 'works on GitLab username',
      mxid: getMxidForGitterUser({
        id: '553d437215522ed4b3df8c50',
        username: 'some-user_gitlab'
      }),
      expectedResult: {
        username: 'some-user_gitlab',
        userId: '553d437215522ed4b3df8c50',
        serverName: configuredServerName
      }
    },
    {
      name: 'does not work when different homeserver',
      mxid: '@some-random-user-553d437215522ed4b3df8c50:matrix.org',
      expectedResult: null
    },
    {
      name: 'does not work when no user ID',
      mxid: getMxidForGitterUser({
        id: '',
        username: 'some-abcde-user'
      }),
      expectedResult: null
    }
  ].forEach(meta => {
    it(meta.name, () => {
      let expectedResult = meta.expectedResult;
      // Just pop on the MXID for comparison which will be the same as what we feed in anyway
      if (meta.expectedResult) {
        expectedResult = {
          ...meta.expectedResult,
          mxid: meta.mxid
        };
      }

      assert.deepEqual(parseGitterMxid(meta.mxid), expectedResult);
    });
  });
});
