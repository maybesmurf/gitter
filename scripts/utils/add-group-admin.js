#!/usr/bin/env node
/*jslint node: true */
'use strict';

// default log level is error
// can be changed with `env "logging:level=info" ./scripts/utils/<name of this script>`
process.env['logging:level'] = process.env['logging:level'] || 'error';

var shutdown = require('shutdown');
var userService = require('gitter-web-users');
var groupService = require('gitter-web-groups/lib/group-service');

require('../../server/event-listeners').install();

const opts = require('yargs')
  .option('username', {
    alias: 'u',
    required: true,
    description: 'User who is going to be the admin'
  })
  .option('groupUri', {
    alias: 'g',
    required: true,
    description: 'Group uri that is going to have a new admin'
  })
  .help('help')
  .alias('help', 'h').argv;

const assignAdmin = async () => {
  try {
    const user = await userService.findByUsername(opts.username);
    if (!user) throw new Error(`user "${opts.username}" hasn't been found`);
    const group = await groupService.findByUri(opts.groupUri);
    if (!group) throw new Error(`group ${opts.groupUri} hasn't been found`);

    group.sd.extraAdmins.push(user._id);
    await group.save();

    console.log(`User ${user.username} with id ${user._id} is now an admin of ${group.uri}`);

    // wait 5 seconds to allow for asynchronous `event-listeners` to finish
    // This isn't clean but works
    // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
    // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    shutdown.shutdownGracefully(0);
  } catch (err) {
    console.error(err);
    shutdown.shutdownGracefully(1);
  }
};

assignAdmin();
