#!/usr/bin/env node

'use strict';

var shutdown = require('shutdown');
var uriLookupService = require('gitter-web-uri-resolver/lib/uri-lookup-service');
var troupeService = require('gitter-web-rooms/lib/troupe-service');
var groupService = require('gitter-web-groups/lib/group-service');
const installBridge = require('gitter-web-matrix-bridge');

var readline = require('readline');
var Promise = require('bluebird');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option('old', {
    alias: 'o',
    required: true,
    description: 'Old uri for the room'
  })
  .option('new', {
    alias: 'n',
    required: true,
    description: 'New uri for the room'
  })
  .option('force', {
    alias: 'f',
    type: 'boolean',
    description: 'Performing changes that caused warnings before'
  })
  .help('help')
  .alias('help', 'h').argv;

var oldUri = opts.old;
var newUri = opts.new;

var lcOld = oldUri.toLowerCase();
var lcNew = newUri.toLowerCase();
var lcNewGroup = lcNew.split(/\//)[0];

function confirm() {
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(function(resolve, reject) {
    rl.question(
      "Use this with caution! Are you sure you want to perform these renames? Type 'yes'? ",
      function(answer) {
        rl.close();

        if (answer === 'yes') return resolve();
        reject(new Error('no'));
      }
    );
  });
}

// eslint-disable-next-line max-statements
async function run() {
  try {
    console.log('Setting up Matrix bridge to propagate any change over to Matrix after the rename');
    await installBridge();

    const room = await troupeService.findByUri(lcOld);
    const clashRoom = await troupeService.findByUri(lcNew);
    const newGroup = await groupService.findByUri(lcNewGroup);

    if (clashRoom) {
      throw new Error('URI Clash: ' + lcNew);
    }
    if (!room) {
      throw new Error('Room does not exist: ' + lcOld);
    }
    if (!newGroup) {
      throw new Error('Attempt to move the room into non-existent group: ' + lcNewGroup);
    }
    if (lcNew === lcNewGroup) {
      throw new Error('Trying to rename room to a group: ' + lcNewGroup);
    }
    if (room.githubType === 'REPO' && !opts.force) {
      throw new Error(`
        WARNING: This repository is associated to a GitHub repository,
        please check that the new name reflects the new GitHub repository name.
        You can force this change with -f option.
      `);
    }

    console.log('BEFORE', {
      uri: room.uri,
      lcUri: room.lcUri,
      groupId: room.groupId,
      renamedLcUris: room.renamedLcUris
    });

    room.uri = newUri;
    room.groupId = newGroup._id;
    room.lcUri = lcNew;

    /* Only add if it's not a case change */
    if (lcOld !== lcNew) {
      room.renamedLcUris.addToSet(lcOld);
    }

    console.log('AFTER', {
      uri: room.uri,
      lcUri: room.lcUri,
      groupId: room.groupId,
      renamedLcUris: room.renamedLcUris
    });

    await confirm();

    console.log('Updating');

    await room.save();

    await uriLookupService.removeBadUri(lcOld);
    await uriLookupService.reserveUriForTroupeId(room.id, lcNew);

    // wait 5 seconds to allow for asynchronous `event-listeners` to finish
    // This isn't clean but works
    // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
    // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
    await new Promise(resolve => setTimeout(resolve, 5000));

    shutdown.shutdownGracefully();
  } catch (err) {
    console.error('--------------------------------------');
    console.error('Error: ' + err, err);
    console.error('--------------------------------------');
    shutdown.shutdownGracefully(1);
  }
}

run();
