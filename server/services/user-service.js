/*jshint globalstrict:true, trailing:false unused:true node:true*/
"use strict";

var persistence = require("./persistence-service"),
    sechash = require('sechash'),
    emailNotificationService = require("./email-notification-service"),
    uuid = require('node-uuid'),
    geocodingService = require("./geocoding-service"),
    winston = require("winston"),
    statsService = require("./stats-service"),
    crypto = require('crypto');

function generateGravatarUrl(email) {
  return  "https://www.gravatar.com/avatar/" + crypto.createHash('md5').update(email).digest('hex') + "?d=identicon";
}

var userService = {
  newUser: function(options) {
    var user = new persistence.User(options);
    user.displayName = options.display;
    user.email = options.email;
    user.gravatarImageUrl = generateGravatarUrl;
    user.status = options.status ? options.status : "UNCONFIRMED";

    user.save(function (err) {
      if(err) winston.error("User save failed: ", err);
    });
  },

  findOrCreateUserForEmail: function(options, callback) {
    winston.info("Locating or creating user", options);

    var displayName = options.displayName;
    var email = options.email;

    persistence.User.findOne({email: email}, function(err, user) {
      if(err) return callback(err);
      if(user) return callback(err, user);

      /* User does not exist */
      user = new persistence.User(options);
      user.displayName = displayName;
      user.email = email;
      user.save(function (err) {
        if(err) return callback(err);

        return callback(null, user);
      });
    });

  },

  findByEmail: function(email, callback) {
    persistence.User.findOne({email: email.toLowerCase()}, function(err, user) {
      callback(err, user);
    });
  },

  findByConfirmationCode: function(confirmationCode, callback) {

    persistence.User.findOne({confirmationCode: confirmationCode}, function(err, user) {
      callback(err, user);
    });
  },

  requestPasswordReset: function(email, callback) {
    winston.info("Requesting password reset", email);

    persistence.User.findOne({email: email}, function(err, user) {
      if(err || !user) return callback(err, user);

      if(user.passwordResetCode) {
        /* Resend the password reset code to the user */
      } else {
        user.passwordResetCode = uuid.v4();
        user.save(); // Async save
      }

      emailNotificationService.sendPasswordResetForUser(user);
      callback(err, user);
    });
  },

  findAndUsePasswordResetCode: function(passwordResetCode, callback) {
    winston.info("Using password reset code", passwordResetCode);

    persistence.User.findOne({passwordResetCode: passwordResetCode}, function(err, user) {
      if(err || !user) return callback(err, user);

      user.passwordResetCode = null;
      user.status = 'PROFILE_NOT_COMPLETED';
      user.passwordHash = null;
      user.save(function(err) {
        if(err) return callback(err);
        callback(err, user);
      });
    });
  },

  findById: function(id, callback) {
    persistence.User.findById(id, function(err, user) {
      callback(err, user);
    });
  },

  findByIds: function(ids, callback) {
    persistence.User.where('_id').in(ids)
      .slaveOk()
      .exec(callback);
  },

  saveLastVisitedTroupeforUser: function(userId, troupeId, callback) {
    winston.info("Saving last visited Troupe for user: ", userId);
    userService.findById(userId, function(err, user) {
      if(err) return callback(err);
      if(!user) return callback("User not found");
      user.lastTroupe = troupeId;

      user.save(function(err) {
        callback(err);
      });
    });
  },

  findDefaultTroupeForUser: function(id, callback) {
    persistence.Troupe.findOne({ 'users.userId': id }, function(err, troupe) {
      callback(err, troupe);
    });
  },

  setUserLocation: function(userId, location, callback) {
    statsService.event("location_submission", {
      userId: userId
    });

    userService.findById(userId, function(err, user) {
      if(err) return callback(err);
      if(!user) return callback(err);

      /* Save new history */
      var history = new persistence.UserLocationHistory({
        userId: user.id,
        timestamp: location.timestamp,
        coordinate: {
            lon:  location.lon,
            lat: location.lat
        },
        speed: location.speed
      }).save(function(err) {
        if(err) winston.error("User location history save failed: ", err);
      });

      function persistUserLocation(named) {
        function nullIfUndefined(v) { return v ? v : null; }

        if(!named) named = {};

        user.location.timestamp = location.timestamp;
        user.location.coordinate.lon = location.lon;
        user.location.coordinate.lat = location.lat;
        user.location.speed = location.speed;
        user.location.altitude = location.altitude;
        user.location.named.place = nullIfUndefined(named.place);
        user.location.named.region = nullIfUndefined(named.region);
        user.location.named.countryCode = nullIfUndefined(named.countryCode);

        user.save(function(err) {
          return callback(err, user);
        });
      }

      geocodingService.reverseGeocode( { lat: location.lat, lon: location.lon }, function(err, namedLocation) {
        if(err || !namedLocation) {
          winston.error("Reverse geocoding failure ", err);
          persistUserLocation(null);
          return;
        } else {
          winston.info("User location (" + location.lon + "," + location.lat + ") mapped to " + namedLocation.name);
          persistUserLocation({
            place: namedLocation.name,
            region: namedLocation.region.name,
            countryCode: namedLocation.country.code
          });
        }
      });
    });
  },

  getUserToken: function(userId, callback) {
    userService.findById(userId, function(err, user) {
      if(err) return callback(err);
      if(!user) return callback(err);

      if(user.userToken) {
        return callback(err, user.userToken);
      }

      // TODO: serious revamp of this security. This is not safe.
      var userToken = uuid.v4();
      user.userToken = userToken;
      user.save(); // Async is fine
      callback(err, userToken);
    });
  },

  updateInitialPassword: function(userId, password, callback) {
    winston.info("Initial password reset", userId);

    persistence.User.findById(userId, function(err, user) {
      if(user.passwordHash) return callback("User already has a password set");

       sechash.strongHash('sha512', password, function(err, hash3) {
         user.passwordHash = hash3;
         return callback(false);
       });
    });
  },

  checkPassword: function(user, password, callback) {
    if(!user.passwordHash) {
      /* User has not yet set their password */
      callback(false);
    }

    sechash.testHash(password, user.passwordHash, function(err, match) {
      if(err) return callback(false);
      callback(match);
    });
  },

  updateProfile: function(options, callback) {
    winston.info("User profile update", options);

    var userId = options.userId;
    var password = options.password;
    var oldPassword = options.oldPassword;
    var displayName = options.displayName;

    userService.findById(userId, function(err, user) {
      if(err) return callback(err);
      if(!user) return callback("User not found");

      if (!user.gravatarImageUrl)
        user.gravatarImageUrl = generateGravatarUrl(user.email);

      function generateNewHashSaveUser() {
        sechash.strongHash('sha512', password, function(err, hash3) {
          if(err) return callback(err);

          user.passwordHash = hash3;
          user.displayName = options.displayName;
          user.save(function(err) {
            callback(err);
          });
        });
      }

      switch(user.status) {
        case 'PROFILE_NOT_COMPLETED':
          if(user.passwordHash) return callback("User already has a password set");
          user.status = 'ACTIVE';
          generateNewHashSaveUser();
          break;

        case 'ACTIVE':
          if(password) {
            sechash.testHash(oldPassword, user.passwordHash, function(err, match) {
              if(err) return callback(err);
              if(!match) return callback({authFailure: true });
              generateNewHashSaveUser();
            });
          } else {
            user.displayName = options.displayName;
            user.save(function(err) {
              callback(err);
            });
          }
          break;

        default:
          callback("Invalid user status");
      }
    });
  }

};

module.exports = userService;