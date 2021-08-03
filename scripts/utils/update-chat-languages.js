#!/usr/bin/env node
'use strict';

var Promise = require('bluebird');
var persistence = require('gitter-web-persistence');
var shutdown = require('shutdown');
var BatchStream = require('batch-stream');
var processText = require('gitter-web-text-processor');

require('../../server/event-listeners').install();

// @const
var BATCH_SIZE = 200;

// progress logging stuff
var totalProcessed = 0;
var success = 0;
var runCalled = 0;

var batchComplete;
var running;

var batch = new BatchStream({ size: BATCH_SIZE });

var stream = persistence.ChatMessage.find({
  $or: [
    {
      lang: null
    },
    {
      lang: { $exists: false }
    }
  ]
})
  .select('text')
  .stream();

stream.pipe(batch);

stream.on('error', function(err) {
  console.log('err.stack:', err.stack);
});

batch.on('data', function(chatMessages) {
  var self = this;

  running = true;
  this.pause(); // pause the stream
  run(chatMessages)
    .then(function() {
      self.resume(); // Resume
      running = false;
      if (batchComplete) {
        batchProcessingComplete();
      }
    })
    .done();
});

function batchProcessingComplete() {
  return (
    Promise.resolve()
      // wait 5 seconds to allow for asynchronous `event-listeners` to finish
      // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
      // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
      .then(() => {
        console.log(
          `Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`
        );
        return new Promise(resolve => setTimeout(resolve, 5000));
      })
      .then(function() {
        logProgress();
        console.log('[FINISHED]\tquitting...');
        shutdown.shutdownGracefully();
      })
  );
}

batch.on('end', function() {
  if (!running) batchProcessingComplete();
  batchComplete = true;
});

// purely for logging
function logProgress() {
  console.log('[PROGRESS]', '\tprocessed:', totalProcessed, '\tsuccess:', success);
}

// responsible for running the procedure
function run(chatMessages) {
  // increment stuff
  runCalled += 1;
  totalProcessed += chatMessages.length;

  if (runCalled % BATCH_SIZE === 0) logProgress();

  return Promise.all(
    chatMessages.map(function(chat) {
      return processText(chat.text)
        .then(function(result) {
          totalProcessed += 1;
          if (totalProcessed % 1000 === 0) {
            logProgress();
          }
          if (result.lang) {
            return persistence.ChatMessage.findByIdAndUpdate(chat.id, {
              $set: { lang: result.lang }
            })
              .exec()
              .then(function() {
                success++;
              });
          }
        })
        .catch(function(err) {
          console.error(err.stack);
        });
    })
  );
}
