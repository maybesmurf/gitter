'use strict';

const ONE_HOUR_MS = 60 * 60 * 1000;

function parseAccessTokenExpiresMsFromRes(resData) {
  const createdAtSeconds = resData.created_at;
  const expiresInSeconds = resData.expires_in;
  // GitLab access tokens expire after 2 hours,
  // https://docs.gitlab.com/14.10/ee/integration/oauth_provider.html
  let accessTokenExpiresMs = Date.now() + 2 * ONE_HOUR_MS;
  // But let's try to grab this info from the request if it exists instead as
  // that behavior could change at any time.
  if (createdAtSeconds && expiresInSeconds) {
    accessTokenExpiresMs = 1000 * (createdAtSeconds + expiresInSeconds);
  }

  return accessTokenExpiresMs;
}

module.exports = parseAccessTokenExpiresMsFromRes;
