'use strict';

const assert = require('assert');
const url = require('url');
const util = require('util');
const request = util.promisify(require('request'));
const Promise = require('bluebird');
const StatusError = require('statuserror');
const debug = require('debug')('gitter:app:gitlab:get-gitlab-access-token-from-user');

const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');
const obfuscateToken = require('gitter-web-github').obfuscateToken;
const identityService = require('gitter-web-identity');
const callbackUrlBuilder = require('gitter-web-oauth/lib/callback-url-builder');

const parseAccessTokenExpiresMsFromRes = require('./parse-access-token-expires-ms-from-res');

async function refreshGitlabAccessToken(identity) {
  debug(
    `refreshGitlabAccessToken ${identity.username} (${identity.providerKey}) refreshToken=${identity.refreshToken}`
  );
  // We're trying to construct a URL that looks like:
  // https://gitlab.com/oauth/token?grant_type=refresh_token&client_id=abc&client_secret=abc&refresh_token=abc&redirect_uri=abc
  const gitlabRefreshTokenUrl = new url.URL('https://gitlab.com/oauth/token');

  gitlabRefreshTokenUrl.searchParams.set('grant_type', 'refresh_token');
  gitlabRefreshTokenUrl.searchParams.set('client_id', config.get('gitlaboauth:client_id'));
  gitlabRefreshTokenUrl.searchParams.set('client_secret', config.get('gitlaboauth:client_secret'));
  gitlabRefreshTokenUrl.searchParams.set('refresh_token', identity.refreshToken);
  gitlabRefreshTokenUrl.searchParams.set('redirect_uri', callbackUrlBuilder('gitlab'));

  const refreshRes = await request({
    method: 'POST',
    uri: gitlabRefreshTokenUrl.toString(),
    json: true,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  if (refreshRes.statusCode !== 200) {
    const apiUrlLogSafe = new url.URL(gitlabRefreshTokenUrl.toString());
    apiUrlLogSafe.searchParams.set('client_id', 'xxx');
    apiUrlLogSafe.searchParams.set('client_secret', 'xxx');
    apiUrlLogSafe.searchParams.set('refresh_token', 'xxx');

    logger.warn(
      `Failed to refresh GitLab access token for ${identity.username} (${
        identity.providerKey
      }) using refreshToken=${obfuscateToken(
        identity.refreshToken
      )}. GitLab API (POST ${apiUrlLogSafe.toString()}) returned ${refreshRes.statusCode}: ${
        typeof refreshRes.body === 'object' ? JSON.stringify(refreshRes.body) : refreshRes.body
      }`
    );
    throw new StatusError(
      500,
      `Unable to refresh expired GitLab access token. You will probably need to sign out and back in to get a new access token or the GitLab API is down. GitLab API returned ${refreshRes.statusCode}`
    );
  }

  const accessTokenExpiresMs = parseAccessTokenExpiresMsFromRes(refreshRes.body);
  assert(accessTokenExpiresMs);

  const accessToken = refreshRes.body.access_token;
  const refreshToken = refreshRes.body.refresh_token;

  const newGitlabIdentityData = {
    accessToken,
    accessTokenExpires: new Date(accessTokenExpiresMs),
    refreshToken
  };

  await identityService.updateById(identity._id || identity.id, newGitlabIdentityData);

  return accessToken;
}

// Cache of ongoing promises to refresh access tokens
const waitingForNewTokenPromiseMap = {};

module.exports = function getGitlabAccessTokenFromUser(user) {
  if (!user) return Promise.resolve();

  return identityService
    .getIdentityForUser(user, identityService.GITLAB_IDENTITY_PROVIDER)
    .then(async function(glIdentity) {
      if (!glIdentity) return null;

      let accessToken = glIdentity.accessToken;
      // If the access token is expired or about to expire by 2 minutes, grab a
      // new access token. 2 minutes is arbitrary but we just want a buffer so
      // that we don't try to use a token which expires right before we try to
      // use it.
      if (
        glIdentity.accessTokenExpires &&
        glIdentity.accessTokenExpires.getTime() - 120 * 1000 < Date.now()
      ) {
        // `getGitlabAccessTokenFromUser` can be called multiple times in quick
        // succession in the same request but we can only exchange the
        // refreshToken once for a new token, so we need to only do this once
        // and re-use this work for all of the callers. This way they all get
        // the new token after we successfully refresh.
        const serializedUserId = mongoUtils.serializeObjectId(user._id || user.id);
        const ongoingPromise = waitingForNewTokenPromiseMap[serializedUserId];
        if (ongoingPromise) {
          return ongoingPromise;
        }

        try {
          waitingForNewTokenPromiseMap[serializedUserId] = refreshGitlabAccessToken(glIdentity);
          accessToken = await waitingForNewTokenPromiseMap[serializedUserId];
        } finally {
          // Regardless of if this failed or succeeded, we are no longer waiting
          // anymore and can clean up our cache for them to try again.
          delete waitingForNewTokenPromiseMap[serializedUserId];
        }
      }

      return accessToken;
    });
};
