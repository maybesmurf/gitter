'use strict';

var env = require('gitter-web-env');
var winston = env.logger;
var assert = require('assert');
var _ = require('lodash');
var Promise = require('bluebird');
var persistence = require('gitter-web-persistence');
var uriLookupService = require('gitter-web-uri-resolver/lib/uri-lookup-service');
var mongooseUtils = require('gitter-web-persistence-utils/lib/mongoose-utils');
var StatusError = require('statuserror');

async function validateUsername(username) {
  // If the username is reserved, then you can't have it
  const reservedUsernameEntry = await persistence.ReservedUsername.findOne({
    lcUsername: username.toLowerCase()
  });
  if (reservedUsernameEntry) {
    throw new StatusError(
      403,
      'You are not allowed to create a user with that username (reserved)'
    );
  }

  // Deal with spammer situation of 25 Sep 2016
  if (
    /^[0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{12}$/.test(
      username
    )
  ) {
    winston.info('Rejecting spam account', {
      username
    });
    throw new StatusError(403, 'You are not allowed to create a user with that username');
  }
}

/** FIXME: the insert fields should simply extend from options or a key in options.
 * Creates a new user
 * @return the promise of a new user
 */
function newUser(options) {
  var githubId = options.githubId;

  assert(githubId, 'githubId required');
  assert(options.username, 'username required');

  var insertFields = {
    githubId: githubId,
    githubUserToken: options.githubUserToken,
    githubToken: options.githubToken,
    githubScopes: options.githubScopes,
    gravatarImageUrl: options.gravatarImageUrl,
    gravatarVersion: options.gravatarVersion,
    username: options.username,
    invitedByUser: options.invitedByUser,
    displayName: options.displayName,
    state: options.state
  };

  if (options.emails && options.emails.length) {
    insertFields.emails = options.emails.map(email => email.toLowerCase());
  }

  // Remove undefined fields
  Object.keys(insertFields).forEach(function(k) {
    if (insertFields[k] === undefined) {
      delete insertFields[k];
    }
  });

  return mongooseUtils
    .upsert(
      persistence.User,
      { githubId: githubId },
      {
        $setOnInsert: insertFields
      }
    )
    .spread(function(user /*, updateExisting*/) {
      //if(raw.updatedExisting) return user;

      // New record was inserted
      //return emailAddressService(user)
      //  .then(function(email) {
      //    stats.userUpdate(_.extend({ email: email }, user.toJSON()));
      //  })
      //  .thenReturn(user);

      return user;
    })
    .then(function(user) {
      // Reserve the URI for the user so that we don't need to figure it out
      // manually later (which will involve dodgy calls to github)
      return uriLookupService.reserveUriForUsername(user._id, user.username).thenReturn(user);
    });
}

function sanitiseUserSearchTerm(term) {
  // remove non username chars
  return (
    term
      .replace(/[^0-9a-z\-]/gi, '')
      // escape dashes
      .replace(/\-/gi, '\\-')
  );
}

var userService = {
  findOrCreateUserForGithubId: async function(options, callback) {
    winston.info('Locating or creating user', options);

    await validateUsername(options.username);

    return userService
      .findByGithubId(options.githubId)
      .then(function(user) {
        if (user) return user;

        return newUser(options);
      })
      .nodeify(callback);
  },

  /**
   * Add the user if one doesn't exist for this identity and set the data for
   * that provider for the user whether the user is new or not.
   * @return promise of [user, isNewIdentity]
   */
  findOrCreateUserForProvider: async function(userData, identityData) {
    winston.info('Locating or creating user', {
      userData: userData,
      identityData: identityData
    });

    // This is not for GitHub. Only for newer providers. At least until we
    // finally migrate all the github data one day.
    assert.notEqual(identityData.provider, 'github');

    await validateUsername(userData.username);

    // TODO: should we assert all the required user and identity fields?

    const userQuery = {
      identities: {
        $elemMatch: {
          provider: identityData.provider,
          providerKey: identityData.providerKey
        }
      }
    };

    const userInsertData = _.extend(
      {
        identities: [
          {
            provider: identityData.provider,
            providerKey: identityData.providerKey
          }
        ]
      },
      userData
    );

    const [user, isExistingUser] = await mongooseUtils.upsert(persistence.User, userQuery, {
      $setOnInsert: userInsertData
    });
    if (user && user.state === 'DISABLED') {
      throw new StatusError(403, 'Account temporarily disabled. Please contact support@gitter.im');
    }

    const isNewUser = !isExistingUser;
    const identityQuery = {
      provider: identityData.provider,
      userId: user._id
    };

    const identitySetData = _.extend(
      {
        userId: user._id
      },
      identityData
    );

    await mongooseUtils.upsert(persistence.Identity, identityQuery, {
      // NOTE: set the identity fields regardless, because the tokens and
      // things could be newer than what we have if this is a login and
      // not a signup.
      $set: identitySetData
    });
    await uriLookupService.reserveUriForUsername(user._id, user.username);
    await this.unremoveUser(user);
    return [user, isNewUser];
  },

  findById: function(id, callback) {
    return persistence.User.findById(id)
      .exec()
      .nodeify(callback);
  },

  /**
   * Returns a hash of booleans if the given usernames exist in gitter
   */
  githubUsersExists: function(usernames, callback) {
    return persistence.User.find(
      { username: { $in: usernames } },
      { username: 1, _id: 0 },
      { lean: true }
    )
      .exec()
      .then(function(results) {
        return results.reduce(function(memo, index) {
          memo[index.username] = true;
          return memo;
        }, {});
      })
      .nodeify(callback);
  },

  findByGithubId: function(githubId, callback) {
    return persistence.User.findOne({ githubId: githubId })
      .exec()
      .nodeify(callback);
  },

  findByGithubIdOrUsername: function(githubId, username, callback) {
    return persistence.User.findOne({ $or: [{ githubId: githubId }, { username: username }] })
      .exec()
      .nodeify(callback);
  },

  findByEmail: function(email, callback) {
    return this.findAllByEmail(email)
      .then(users => {
        return users[0];
      })
      .nodeify(callback);
  },

  findAllByEmail: async function(email) {
    const identity = await persistence.Identity.findOne({ email: email }).exec();

    let usersFromIdentity = [];
    if (identity) {
      usersFromIdentity = await persistence.User.find({
        identities: {
          $elemMatch: {
            provider: identity.provider,
            providerKey: identity.providerKey
          }
        }
      });
    }

    const usersFromEmail = await persistence.User.find({
      $or: [{ email: email.toLowerCase() }, { emails: email.toLowerCase() }]
    }).exec();

    // Remove the duplicates
    const userMap = usersFromEmail.concat(usersFromIdentity).reduce(function(memo, user) {
      memo[user.id] = user;
      return memo;
    }, {});

    // Using Promise.resolve to return a Bluebird flavor promise for downstream code that uses it
    return Promise.resolve(Object.values(userMap));
  },

  findByEmailsIndexed: function(emails, callback) {
    emails = emails.map(function(email) {
      return email.toLowerCase();
    });

    return persistence.User.find({ $or: [{ email: { $in: emails } }, { emails: { $in: emails } }] })
      .exec()
      .then(function(users) {
        return users.reduce(function(memo, user) {
          memo[user.email] = user;

          user.emails.forEach(function(email) {
            memo[email] = user;
          });

          return memo;
        }, {});
      })
      .nodeify(callback);
  },

  findByUsername: function(username, callback) {
    return persistence.User.findOne({ username: username })
      .exec()
      .nodeify(callback);
  },

  findByIds: function(ids, { read } = {}) {
    return mongooseUtils.findByIds(persistence.User, ids, { read });
  },

  findByIdsLean: function(ids, select) {
    return mongooseUtils.findByIdsLean(persistence.User, ids, select);
  },

  findByIdsAndSearchTerm: function(ids, searchTerm, limit, callback) {
    if (!ids || !ids.length || !searchTerm || !searchTerm.length) {
      return Promise.resolve([]).nodeify(callback);
    }

    var searchPattern = '^' + sanitiseUserSearchTerm(searchTerm);
    return persistence.User.find({
      _id: { $in: ids },
      $or: [
        { username: { $regex: searchPattern, $options: 'i' } },
        { displayName: { $regex: searchPattern, $options: 'i' } }
      ]
    })
      .limit(limit)
      .exec()
      .nodeify(callback);
  },

  findByUsernames: function(usernames, callback) {
    if (!usernames || !usernames.length) return Promise.resolve([]).nodeify(callback);

    return persistence.User.where('username')
      ['in'](usernames)
      .exec()
      .nodeify(callback);
  },

  findByLogin: function(login, callback) {
    var byEmail = login.indexOf('@') >= 0;
    var find = byEmail ? userService.findByEmail(login) : userService.findByUsername(login);

    return find
      .then(function(user) {
        return user;
      })
      .nodeify(callback);
  },

  /**
   * Find the username of a single user
   * @return promise of a username or undefined if user or username does not exist
   */
  findUsernameForUserId: function(userId) {
    return persistence.User.findOne({ _id: userId }, 'username')
      .exec()
      .then(function(user) {
        return user && user.username;
      });
  },

  deleteAllUsedInvitesForUser: function(user) {
    persistence.Invite.remove({ userId: user.id, status: 'USED' });
  },

  destroyTokensForUserId: function(userId) {
    return persistence.User.update(
      { _id: userId },
      { $set: { githubToken: null, githubScopes: {}, githubUserToken: null } }
    ).exec();
  },

  /* Update the timezone information for a user */
  updateTzInfo: function(userId, timezoneInfo) {
    var update = {};

    function setUnset(key, value) {
      if (value) {
        if (!update.$set) update.$set = {};
        update.$set['tz.' + key] = value;
      } else {
        if (!update.$unset) update.$unset = {};
        update.$unset['tz.' + key] = true;
      }
    }

    setUnset('offset', timezoneInfo.offset);
    setUnset('abbr', timezoneInfo.abbr);
    setUnset('iana', timezoneInfo.iana);

    return persistence.User.update({ _id: userId }, update).exec();
  },

  reserveUsername: async function(username) {
    assert(username);

    return mongooseUtils.upsert(
      persistence.ReservedUsername,
      {
        lcUsername: username.toLowerCase()
      },
      {
        $setOnInsert: {
          username,
          lcUsername: username.toLowerCase()
        }
      }
    );
  },

  unreserveUsername: async function(username) {
    return persistence.ReservedUsername.remove({
      lcUsername: username.toLowerCase()
    });
  },

  hellbanUser: async function(userId) {
    const username = await this.findUsernameForUserId(userId);

    // Reserve their username to make the ban permanent
    // so when the bad actor tries to delete/ghost their account and then come back,
    // it doesn't allow them to create their user again.
    await this.reserveUsername(username);

    return persistence.User.update(
      { _id: userId },
      {
        $set: {
          hellbanned: true
        }
      }
    ).exec();
  },

  unhellbanUser: async function(userId) {
    const username = await this.findUsernameForUserId(userId);

    await this.unreserveUsername(username);

    return persistence.User.update(
      { _id: userId },
      {
        $set: {
          hellbanned: false
        }
      }
    ).exec();
  },

  // This removes the state of the user when its value is 'REMOVED'.
  // This is typically called when the user just logged in, and is useful after
  // the user deleted their account.
  unremoveUser: async user => {
    if (user.state === 'REMOVED') {
      user.state = undefined;
      await user.save();
    }
  }
};

module.exports = userService;
