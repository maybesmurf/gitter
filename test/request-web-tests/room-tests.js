'use strict';

process.env.DISABLE_MATRIX_BRIDGE = '1';
process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';

const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const fixtureUtils = require('gitter-web-test-utils/lib/fixture-utils');
const assert = require('assert');
const request = require('supertest');
const env = require('gitter-web-env');
const config = env.config;
const ensureMatrixFixtures = require('./utils/ensure-matrix-fixtures');
const registerTestSynapseUser = require('./utils/register-test-synapse-user');

const installBridge = require('gitter-web-matrix-bridge');
const matrixBridge = require('gitter-web-matrix-bridge/lib/matrix-bridge');
const GitterUtils = require('gitter-web-matrix-bridge/lib/gitter-utils');
const getMxidForGitterUser = require('gitter-web-matrix-bridge/lib/get-mxid-for-gitter-user');

const app = require('../../server/web');

const serverName = config.get('matrix:bridge:serverName');
const bridgePortFromConfig = config.get('matrix:bridge:applicationServicePort');

// Finds the regex in the text and creates an excerpt so the test failure message can more easily be understood
function findInText(text, regex, excerptBufferLength = 16) {
  const result = text.match(regex);

  if (result) {
    return {
      excerpt: text.substring(
        Math.max(0, result.index - excerptBufferLength),
        Math.min(result.index + result[0].length + excerptBufferLength, text.length - 1)
      )
    };
  }
}

describe('Rooms', function() {
  const fixture = fixtureLoader.setup({
    user1: {
      accessToken: 'web-internal'
    },
    user2: {
      accessToken: 'web-internal'
    },
    troupeUnjoined1: {}
  });

  it(`Ensure there aren't unserialized documents handed off to the frontend`, async () => {
    const result = await request(app)
      .get(`/${fixture.troupeUnjoined1.uri}`)
      .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
      .expect(200);

    const idFindResults = findInText(result.text, /\b_id\b/m);
    assert(
      !idFindResults,
      `response should not include unserialized \`_id\` property (expecting \`id\`): ${idFindResults &&
        idFindResults.excerpt}`
    );

    const versionFindResults = findInText(result.text, /\b__v\b/m);
    assert(
      !versionFindResults,
      `response should not include unserialized \`__v\` property (expecting \`v\` or nothing): ${versionFindResults &&
        versionFindResults.excerpt}`
    );
  });

  describe('Matrix DMs', () => {
    let gitterUtils;
    before(async () => {
      await ensureMatrixFixtures();

      await installBridge(bridgePortFromConfig + 1);

      gitterUtils = new GitterUtils(matrixBridge);
    });

    it(`Creates Matrix DM when visiting URL`, async () => {
      const localPart = fixtureUtils.generateUsername().slice(1);
      const mxid = `@${localPart}:${serverName}`;
      await registerTestSynapseUser(localPart);

      await request(app)
        .get(`/matrix/${fixture.user1.id}/${mxid}`)
        .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
        .expect(200);
    });

    it(`able to look at DM room for youself even when you're not joined`, async () => {
      const mxid = `@${fixtureUtils.generateUsername().slice(1)}:${serverName}`;

      const gitterRoom = await gitterUtils.createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        fixture.user1.id,
        mxid
      );

      await request(app)
        .get(`/${gitterRoom.uri}`)
        .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
        .expect(200);
    });

    it(`DM room is private`, async () => {
      const mxid = `@${fixtureUtils.generateUsername().slice(1)}:${serverName}`;

      const gitterRoom = await gitterUtils.createGitterDmRoomByGitterUserIdAndOtherPersonMxid(
        fixture.user1.id,
        mxid
      );

      await request(app)
        .get(`/${gitterRoom.uri}`)
        // User2 trying to view user1 room is not allowed
        .set('Authorization', `Bearer ${fixture.user2.accessToken}`)
        .expect(404);
    });

    it(`another user can't start a DM for another user by visiting their URL`, async () => {
      const mxid = `@${fixtureUtils.generateUsername().slice(1)}:${serverName}`;

      await request(app)
        // DM between user1 and mxid
        .get(`/matrix/${fixture.user1.id}/${mxid}`)
        // Accessing from user2
        .set('Authorization', `Bearer ${fixture.user2.accessToken}`)
        .expect(403);
    });

    it(`can not start DM with the MXID for a Gitter user`, async () => {
      const otherGitterUserMxid = getMxidForGitterUser(fixture.user2);

      await request(app)
        .get(`/matrix/${fixture.user1.id}/${otherGitterUserMxid}`)
        .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
        .expect(404);
    });

    it(`Non-existant MXID shows a 404`, async () => {
      const mxid = `@${fixtureUtils.generateUsername().slice(1)}:does-not-exist`;

      await request(app)
        .get(`/matrix/${fixture.user1.id}/${mxid}`)
        .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
        .expect(404);
    });
  });
});
