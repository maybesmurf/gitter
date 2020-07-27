'use strict';

process.env.DISABLE_API_LISTEN = '1';
process.env.DISABLE_API_WEB_LISTEN = '1';
process.env.TEST_EXPORT_RATE_LIMIT = 100;

const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');
const assert = require('assert');
const request = require('supertest');

const app = require('../../../server/web');

describe('user-messages-export-api', function() {
  fixtureLoader.ensureIntegrationEnvironment('#oauthTokens');

  before(function() {
    if (this._skipFixtureSetup) return;
  });

  var fixture = fixtureLoader.setup({
    user1: {
      accessToken: 'web-internal',
      // TODO: This won't be necessary in the future #no-staff-for-export
      staff: true
    },
    userNoExport1: {
      accessToken: 'web-internal'
    }
  });

  it('GET /api_web/export/user/:user_id/messages.ndjson unauthorized returns nothing', function() {
    return request(app)
      .get(`/api_web/export/user/${fixture.user1.id}/messages.ndjson`)
      .set('Accept', 'application/x-ndjson,application/json')
      .expect(401)
      .then(function(result) {
        assert.deepEqual(result.body, { success: false, loginRequired: true });
      });
  });

  it('GET /api_web/export/user/:user_id/messages.ndjson forbidden returns nothing', function() {
    return request(app)
      .get(`/api_web/export/user/${fixture.user1.id}/messages.ndjson`)
      .set('Accept', 'application/x-ndjson,application/json')
      .set('Authorization', `Bearer ${fixture.userNoExport1.accessToken}`)
      .expect(403)
      .then(function(result) {
        assert.deepEqual(result.body, { error: 'Forbidden' });
      });
  });

  it('GET /api_web/export/user/:user_id/messages.ndjson as <img> does not work', function() {
    return request(app)
      .get(`/api_web/export/user/${fixture.user1.id}/messages.ndjson`)
      .set('Accept', 'image/*')
      .set('Authorization', `Bearer ${fixture.user1.accessToken}`)
      .expect(406)
      .then(function(result) {
        assert.deepEqual(result.body, {});
      });
  });
});