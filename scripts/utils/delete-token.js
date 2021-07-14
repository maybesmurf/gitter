#!/usr/bin/env node
/*jslint node:true */
'use strict';

process.env.NO_AUTO_INDEX = 1;

var shutdown = require('shutdown');
var oauthService = require('gitter-web-oauth');

require('../../server/event-listeners').install();

var opts = require('yargs')
  .option('token', {
    alias: 't',
    required: true,
    description: 'Token to delete'
  })
  .help('help')
  .alias('help', 'h').argv;

function runScript(token) {
  return oauthService.deleteToken(token);
}

runScript(opts.token)
  // wait 5 seconds to allow for asynchronous `event-listeners` to finish
  // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
  // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
  .then(() => {
    console.log(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    return new Promise(resolve => setTimeout(resolve, 5000));
  })
  .then(function() {
    shutdown.shutdownGracefully(0);
  })
  .catch(function(e) {
    console.error(e);
    console.error(e.stack);
    shutdown.shutdownGracefully(1);
  })
  .done();
