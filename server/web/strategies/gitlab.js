'use strict';

const assert = require('assert');
var env = require('gitter-web-env');
var config = env.config;

var GitLabStrategy = require('passport-gitlab2');
var userService = require('gitter-web-users');
var trackSignupOrLogin = require('../track-signup-or-login');
var updateUserLocale = require('../update-user-locale');
var passportLogin = require('../passport-login');
var identityService = require('gitter-web-identity');
var callbackUrlBuilder = require('gitter-web-oauth/lib/callback-url-builder');
const parseAccessTokenExpiresMsFromRes = require('gitter-web-gitlab/lib/parse-access-token-expires-ms-from-res');

function gitlabOauthCallback(req, token, refreshToken, params, profile, done) {
  const accessTokenExpiresMs = parseAccessTokenExpiresMsFromRes(params);
  assert(accessTokenExpiresMs);

  var gitlabUser = {
    username: profile.username + '_gitlab',
    displayName: profile.displayName,
    gravatarImageUrl: profile.avatarUrl
  };
  var gitlabIdentity = {
    provider: identityService.GITLAB_IDENTITY_PROVIDER,
    providerKey: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    email: profile._json.email && profile._json.email.toLowerCase(),
    accessToken: token,
    accessTokenExpires: new Date(accessTokenExpiresMs),
    refreshToken,
    avatar: profile.avatarUrl
  };

  return userService
    .findOrCreateUserForProvider(gitlabUser, gitlabIdentity)
    .then(function([user, isNewUser]) {
      trackSignupOrLogin(req, user, isNewUser, 'gitlab');
      updateUserLocale(req, user);

      return passportLogin(req, user);
    })
    .then(result => done(null, result), error => done(error));
}

var gitlabStrategy = new GitLabStrategy(
  {
    clientID: config.get('gitlaboauth:client_id'),
    clientSecret: config.get('gitlaboauth:client_secret'),
    callbackURL: callbackUrlBuilder('gitlab'),
    // Prevent CSRF by adding a state query parameter through the OAuth flow that is connected to the users session.
    // These options come from the `require('passport-oauth2').Strategy`,
    // https://github.com/jaredhanson/passport-oauth2/blob/master/lib/strategy.js
    state: true,
    passReqToCallback: true,
    scope: ['read_user', 'api'],
    scopeSeparator: ' '
  },
  gitlabOauthCallback
);

gitlabStrategy.name = 'gitlab';

module.exports = gitlabStrategy;
