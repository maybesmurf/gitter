/*jshint globalstrict: true, trailing: false, unused: true, node: true */
"use strict";

var _                       = require('underscore');
var uuid                    = require('node-uuid');
var sechash                 = require('sechash');
var winston                 = require('../utils/winston');
var redis                   = require("../utils/redis");
var nconf                   = require('../utils/config');
var userService             = require('../services/user-service');
var statsService            = require("../services/stats-service");
var useragent               = require('useragent');
var useragentStats          = require('./useragent-stats');

var cookieName = nconf.get('web:cookiePrefix') + 'auth';

var redisClient = redis.createClient();

function generateAuthToken(req, res, userId, options, callback) {
  options = options ? options : {};
  var timeToLiveDays = options.timeToLiveDays ? options.timeToLiveDays : 30;

  var key = uuid.v4();
  var token = uuid.v4();
  res.cookie(cookieName, key + ":" + token, {
    domain: nconf.get("web:cookieDomain"),
    maxAge: 1000 * 60 * 60 * 24 * timeToLiveDays,
    secure: false,
    httpOnly: true
  });

  sechash.strongHash('sha512', token, function(err, hash3) {
    if(err) return callback(err);

    var json = JSON.stringify({userId: userId, hash: hash3});
    redisClient.setex("rememberme:" + key, 60 * 60 * 24 * timeToLiveDays, json);

    callback(null);
  });
}

function getAndDeleteRedisKey(key, callback) {
  redisClient.multi()
    .get(key)
    .del(key)
    .exec(function(err, replies) {
      if(err) return callback(err);
      var getResult = replies[0];
      return callback(null, getResult);
    });
}

/* Validate a token and call callback(err, userId) */
function validateAuthToken(authCookieValue, callback) {
    /* Auth cookie */
    if(!authCookieValue) return callback();

    winston.verbose('rememberme: Client has presented a rememberme auth cookie, attempting reauthentication');

    var authToken = authCookieValue.split(":", 2);

    if(authToken.length != 2) return callback();

    var key = authToken[0];
    var hash = authToken[1];

    getAndDeleteRedisKey("rememberme:" + key, function(err, storedValue) {
      if(err) return callback(err);

      if(!storedValue) {
        winston.info("rememberme: Client presented illegal rememberme token ", { token: key });
        return callback();
      }

      var stored = JSON.parse(storedValue);

      sechash.testHash(hash, stored.hash, function(err, match) {
        if(err || !match) return callback();
        var userId = stored.userId;

        return callback(null, userId);
      });
    });
}

module.exports = {
  generateAuthToken: generateAuthToken,

  deleteRememberMeToken: function(token, callback) {
      validateAuthToken(token, function(err) {
        if(err) { winston.warn('Error validating token, but ignoring error ' + err, { exception: err }); }

        return callback();
      });
  },

  rememberMeMiddleware: function(options) {
    return function(req, res, next) {
      function fail(err) {
        res.clearCookie(cookieName, { domain: nconf.get("web:cookieDomain") });
        if(err) return next(err);

        return next();
      }

      /* If the user is logged in, no problem */
      if (req.user) return next();

      if(!req.cookies) return next();

      validateAuthToken(req.cookies[cookieName], function(err, userId) {
        if(err || !userId) return fail(err);

        userService.findById(userId, function(err, user) {
          if(err)  return fail(err);
          if(!user) return fail();

          req.login(user, options, function(err) {
            if(err) {
              winston.info("rememberme: Passport login failed", { exception: err  });
              return fail(err);
            }

            winston.verbose("rememberme: Passport login succeeded");

            // Tracking
            var properties = useragentStats(req.headers['user-agent']);
            statsService.userUpdate(user, properties);

            statsService.event("user_login", _.extend({
              userId: userId,
              method: 'auto',
              email: user.email
            }, properties));

            generateAuthToken(req, res, userId, options, function(err) {
              return next(err);
            });

          });

        });

      });


    };
  }
};
