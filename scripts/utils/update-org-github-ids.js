#!/usr/bin/env node
'use strict';

var persistence = require('gitter-web-persistence');
var onMongoConnect = require('gitter-web-persistence-utils/lib/on-mongo-connect');
var through2Concurrent = require('through2-concurrent');
var Promise = require('bluebird');
var GitHubOrgService = require('gitter-web-github').GitHubOrgService;

require('../../server/event-listeners').install();

function orgStream() {
  return persistence.Troupe.find(
    { githubType: 'ORG', $or: [{ githubId: null }, { githubId: { $exists: false } }] },
    { uri: 1 }
  )
    .lean()
    .stream();
}

var orgService = new GitHubOrgService();
function updateOrgRoom(room) {
  if (room.uri.indexOf('_test_') === 0) return Promise.resolve();

  return orgService.getOrg(room.uri).then(function(org) {
    if (!org) return;
    console.log('UPDATE ' + room.uri, 'GITHUB ID ', org.id);
    return persistence.Troupe.update(
      { _id: room._id, $or: [{ githubId: null }, { githubId: { $exists: false } }] },
      { githubId: org.id }
    ).exec();
  });
}

function performMigration() {
  return new Promise(function(resolve) {
    var count = 0;
    orgStream()
      .pipe(
        through2Concurrent.obj({ maxConcurrency: 6 }, function(room, enc, callback) {
          var self = this;
          return updateOrgRoom(room)
            .then(function() {
              self.emit(room.uri);
            })
            .catch(function(err) {
              console.log(err);
            })
            .nodeify(callback);
        })
      )
      .on('data', function() {
        count++;
        if (count % 100 === 0) {
          console.log('Completed ', count);
        }
      })
      .on('end', function() {
        console.log('DONE');
        resolve();
      });
  });
}

onMongoConnect()
  .then(function() {
    return performMigration();
  })
  // wait 5 seconds to allow for asynchronous `event-listeners` to finish
  // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
  // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
  .then(() => {
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    return new Promise(resolve => setTimeout(resolve, 5000));
  })
  .then(function() {
    process.exit();
  })
  .catch(function(err) {
    console.error(err.stack);
    process.exit(1);
  })
  .done();
