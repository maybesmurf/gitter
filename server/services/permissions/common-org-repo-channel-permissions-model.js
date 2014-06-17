/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var Q = require('q');

var ALLOWED_SECURITY_VALUES = {
  PRIVATE: 1,
  PUBLIC: 1,
  INHERITED: 1
};

/**
 * COMMON_ORG_REPO_CHANNEL permissions model
 *
 * Commom code for `org-channel-permissions-model` and `repo-channel-permissions-model`
 *
 * `userIsInRoom` and `premiumOrThrow` MUST BE required from the original module,
 * otherwise the tests will fail because `proxyquire` will not apply its replacements
 */
module.exports = function(delegatePermissionsModel, userIsInRoom, premiumOrThrow) {

  return function commonChannelPermissionsModel(user, right, uri, security) {
    if(!ALLOWED_SECURITY_VALUES.hasOwnProperty(security)) {
      return Q.reject(new Error('Invalid security type:' + security));
    }

    // Anyone can view a public ORG or REPO channel
    if(right === 'view' && security === 'PUBLIC') {
      return Q.resolve(true);
    }

    // No unauthenticated past this point
    if(!user) return Q.resolve(false);

    var uriParts = uri.split('/');
    var uriLastPart = uriParts.slice(0, -1).join('/');
    var uriFirstPart = uriParts[0];

    switch(right) {
      case 'join':
      case 'view':
        switch(security) {
          case 'PUBLIC': return Q.resolve(true);
          case 'PRIVATE':
            return userIsInRoom(uri, user);

          case 'INHERITED':
            return delegatePermissionsModel(user, right, uriLastPart);
          default:
            throw 'Unknown security: ' + security;
        }
        break;

      case 'adduser':
        switch(security) {
          case 'PUBLIC':
            return Q.resolve(true);

          case 'PRIVATE':
            return Q.all([
                      userIsInRoom(uri, user),
                      delegatePermissionsModel(user, right, uriLastPart)
                    ])
                    .spread(function(inRoom, perm) {
                      return inRoom && perm;
                    });

          case 'INHERITED':
            return delegatePermissionsModel(user, right, uriLastPart);
          default:
            throw 'Unknown security: ' + security;
        }
        break;

      case 'create':
        /* Anyone who can CREATE an ORG or REPO can create a child channel */
        var delegatePermissionPromise = delegatePermissionsModel(user, 'create', uriLastPart);

        switch(security) {
          case 'PUBLIC':
            return delegatePermissionPromise;

          case 'PRIVATE':
          case 'INHERITED':
            return delegatePermissionPromise
              .then(function(access) {
                if(!access) return false;

                return premiumOrThrow(uriFirstPart);
              });
          default:
            throw new Error('Illegal state');
        }
        break;

      case 'admin':
        /* Anyone who can join an ORG or REPO can create a child channel */
        return delegatePermissionsModel(user, 'admin', uriLastPart);

      default:
        throw 'Unknown right ' + right;
    }
  };
};
