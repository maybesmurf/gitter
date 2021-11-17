'use strict';

var assert = require('assert');
var Promise = require('bluebird');
var VirtualUserPolicyEvaluator = require('../../lib/policies/virtual-user-policy-evaluator');

describe('virtual-user-policy-evaluator', function() {
  const FIXTURES = [
    {
      name: 'normal virtual user can write',
      virtualUser: {
        type: 'matrix',
        externalId: 'virtual-user:matrix.org'
      },
      sd: {
        public: true
      },
      canRead: true,
      canWrite: true,
      canJoin: true,
      canAdmin: false,
      canAddUser: true
    },
    {
      name: `banned virtual user can't write`,
      virtualUser: {
        type: 'matrix',
        externalId: 'banned-user:matrix.org'
      },
      sd: {
        public: true,
        bans: [
          {
            id: '666',
            virtualUser: {
              type: 'matrix',
              externalId: 'banned-user:matrix.org'
            },
            dateBanned: Date.now(),
            bannedBy: '999'
          }
        ]
      },
      canRead: true,
      canWrite: false,
      canJoin: false,
      canAdmin: false,
      canAddUser: false
    }
  ];

  FIXTURES.forEach(function(meta) {
    it(meta.name, function() {
      const evaluator = new VirtualUserPolicyEvaluator(meta.virtualUser, meta.sd);

      return Promise.join(
        evaluator.canRead(),
        evaluator.canWrite(),
        evaluator.canJoin(),
        evaluator.canAdmin(),
        evaluator.canAddUser(),
        function(read, write, join, admin, addUser) {
          assert.strictEqual(read, meta.canRead, 'expected canRead does not match');
          assert.strictEqual(write, meta.canWrite, 'expected canWrite does not match');
          assert.strictEqual(join, meta.canJoin, 'expected canJoin does not match');
          assert.strictEqual(admin, meta.canAdmin, 'expected canAdmin does not match');
          assert.strictEqual(addUser, meta.canAddUser, 'expected canAddUser does not match');
        }
      );
    });
  });
});
