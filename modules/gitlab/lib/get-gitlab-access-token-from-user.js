'use strict';

const url = require('url');
const util = require('util');
const request = util.promisify(require('request'));
const Promise = require('bluebird');
const StatusError = require('statuserror');

const identityService = require('gitter-web-identity');
const callbackUrlBuilder = require('gitter-web-oauth/lib/callback-url-builder');
const env = require('gitter-web-env');
const config = env.config;

const ONE_HOUR_MS = 60 * 60 * 1000;

async function refreshGitlabAccessToken(identity) {
  // We're trying to construct a URL that looks like:
  // https://gitlab.com/oauth/token?grant_type=refresh_token&client_id=abc&client_secret=abc&refresh_token=abc&redirect_uri=abc
  const gitlabRefreshTokenUrl = new url.URL('https://gitlab.com/oauth/token');

  gitlabRefreshTokenUrl.searchParams.grant_type = 'refresh_token';
  gitlabRefreshTokenUrl.searchParams.client_id = config.get('gitlaboauth:client_id');
  gitlabRefreshTokenUrl.searchParams.client_secret = config.get('gitlaboauth:client_secret');
  gitlabRefreshTokenUrl.searchParams.refresh_token = identity.refreshToken;
  gitlabRefreshTokenUrl.searchParams.redirect_uri = callbackUrlBuilder('gitlab');

  const refreshRes = await request({
    method: 'POST',
    uri: gitlabRefreshTokenUrl.toString(),
    json: true,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  if (refreshRes.statusCode !== 200) {
    throw new StatusError(
      500,
      'Unable to refresh expired GitLab access token. You will probably need to sign out and back in to get a new access token or the GitLab API is down.'
    );
  }

  const createdAtSeconds = refreshRes.body.created_at;
  const expiresInSeconds = refreshRes.body.expires_in;
  // GitLab access tokens expire after 2 hours,
  // https://docs.gitlab.com/14.10/ee/integration/oauth_provider.html
  let accessTokenExpiresMs = 2 * ONE_HOUR_MS;
  // But let's try to grab this info from the request if it exists instead as
  // that behavior could change at any time.
  if (createdAtSeconds && expiresInSeconds) {
    accessTokenExpiresMs = 1000 * (createdAtSeconds + expiresInSeconds);
  }

  const accessToken = refreshRes.body.access_token;
  const refreshToken = refreshRes.body.refresh_token;

  const newGitlabIdentityData = {
    accessToken,
    accessTokenExpires: new Date(accessTokenExpiresMs),
    refreshToken
  };

  await identityService.updateById(identity._id, newGitlabIdentityData);

  return accessToken;
}

module.exports = function(user) {
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
        glIdentity.accessTokenExpires.getTime() - 120 * 1000 > Date.now()
      ) {
        accessToken = await refreshGitlabAccessToken(glIdentity);
      }

      return accessToken;
    });
};
