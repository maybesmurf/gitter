/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var nconf = require('./config');
var winston = require("winston");
var fs = require('fs');
var path = require('path');
var Q = require('q');

function statFile(fileTransport) {
  if(!fileTransport) return;

  var fullname = path.join(fileTransport.dirname, fileTransport._getFile(false));

  function reopen() {
    fileTransport.close();
    fileTransport._stream = null;
    fileTransport.once('open', function() {
      winston.info('Log rotation completed');
      console.log('Log rotation completed');
    });
  }

  fs.stat(fullname, function (err, stat) {
    if (err && err.code == 'ENOENT') {
      console.log('Log file no longer exists. Reopening');
      return reopen();
    }

    if(fileTransport._stream && fileTransport._stream.fd) {

      fs.fstat(fileTransport._stream.fd, function(err2, fstat) {
        if(stat.dev != fstat.dev || stat.ino !== fstat.ino) {
          console.log('File inode mismatch. Reopening');
          return reopen();
        }
      });

    }

  });
}

var periodicListenerConfigured = false;
function periodicallyStatFile() {
  if(periodicListenerConfigured) return;
  periodicListenerConfigured = true;

  setInterval(function() {
    statFile(winston['default'].transports.file);
  }, 30000);
}

var hupListenerConfigured = false;
function reopenTransportOnHupSignal() {
  if(hupListenerConfigured) return;
  hupListenerConfigured = true;

  process.on('SIGHUP', function() {
    console.log('Caught SIGHUP, attempting logfile rotation');
    winston.info('Caught SIGHUP, attempting logfile rotation');

    statFile(winston['default'].transports.file);

  });
}


function configureTransports() {
  var defaultLogger = winston['default'];

  for (var name in defaultLogger.transports) {
    winston.remove({ name: name });
  }

  if(nconf.get('logging:logToFile') && nconf.get('LOG_FILE')) {
    winston.add(winston.transports.File, {
      filename: nconf.get('LOG_FILE'),
      level: nconf.get("logging:level"),
      timestamp: true,
      maxFiles: null,
      maxsize: null,
      json: false
    });

    var fileTransport = winston['default'].transports.file;
    periodicallyStatFile(fileTransport);
    reopenTransportOnHupSignal(fileTransport);

  } else {
    if(nconf.get('logging:logToFile') && !nconf.get('LOG_FILE')) {
      console.log('Logging to file is configured by LOG_FILE environment variable has not been set. Logging to console');
    }

    winston.add(winston.transports.Console, {
      colorize: nconf.get("logging:colorize"),
      timestamp: nconf.get("logging:timestamp"),
      level: nconf.get("logging:level"),
      prettyPrint: nconf.get("logging:prettyPrint")
    });

  }

  if(nconf.get("logging:loggly")) {
    //
    // Requiring `winston-loggly` will expose
    // `winston.transports.Loggly`
    //
    require('winston-loggly');

    winston.add(winston.transports.Loggly, {
      level: nconf.get("logging:logglyLevel"),
      subdomain: nconf.get("logging:logglySubdomain"),
      inputToken: nconf.get("logging:logglyInputToken")
    });

  }
}

configureTransports();


var oldError = winston.error;
winston.error = function(message, data) {
  function formatStackTrace(stack) {
    if(stack.join) {
      return stack.join('\n');
    }

    return '' + stack;
  }


  if(data && data.exception) {
    console.error(data.exception);

    if(data.exception.stack) {
        data.stack = formatStackTrace(data.exception.stack);
    }

    if(data.exception.message) {
      data.errorMessage = data.exception.message;
      delete data.exception;
    }
  }
  oldError.apply(winston, arguments);

};

var logLevel = nconf.get("logging:level");

nconf.events.on('reload', function() {
  if(logLevel ===  nconf.get("logging:level")) {
    return;
  }

  logLevel = nconf.get("logging:level");
  console.log("Reconfiguring log transports");

  configureTransports();
});



// This really doens't have a home, but logging shows stack
// traces, so it'll go here for now
Q.longStackSupport = !!nconf.get("logging:longStackSupport");
Error.stackTraceLimit = 100;

module.exports = winston;