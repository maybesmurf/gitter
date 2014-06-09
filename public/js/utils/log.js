/*jshint strict:true, undef:true, unused:strict, browser:true *//* global define:false, console:false */
define(function() {
  "use strict";

  var history;
  var DEBUG = false;
  if (DEBUG) {
    history = window.logHistory = [];
  }

  function nullLog() {}

  function ieLog(a0) {
    console.log(a0);
  }

  function consoleApply(type) {
    type = type || 'log';

    if (!console[type]) return consoleApply('log');

    return function() {
      console[type].apply(console, Array.prototype.slice.apply(arguments));

      if (DEBUG) {
        history.push(Array.prototype.join.call(arguments, ', '));
        if(history.length > 500)
          history.shift();
      }
    };
  }

  if (typeof console == "undefined") return nullLog;
  if (typeof console.log == "object") return ieLog;

  var consoleLog = consoleApply('log');
  consoleLog.log = consoleApply('log');
  consoleLog.warn = consoleApply('warn');
  consoleLog.error = consoleApply('error');

  return consoleLog;
});
