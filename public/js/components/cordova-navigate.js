/*jshint strict:true, undef:true, unused:strict, browser:true *//* global define:false */
define([
  'jquery',
  'underscore'
], function($, _) {
  "use strict";

  var cordova = window.cordova;
  var noop = function() {};

  function getIdForUri(uri, cb) {
    $.post('/api/v1/rooms', { uri: uri }, function() {
      $.get('/api/v1/rooms', function(rooms) {
        var room = _.findWhere(rooms, { uri: uri });
        cb(null, room.id);
      });
    });
  }

  var updateNativeContext = function(troupeId, title) {
    var url = window.location.origin + '/mobile/chat#' + troupeId;
    var context = 'troupe';
    var altContext = 'chat';
    cordova.exec(
      noop,
      noop,
      "TroupeContext",
      "updateContext",
      [ url, context, troupeId, altContext, title ]
    );
  };

  var updateNativeContextWithTroupe = function(troupe) {
    var name = troupe.get('name');
    var id = troupe.get('id');

    if(id && name) {
      updateNativeContext(id, name);
    }
  };

  return {
    navigate: function(pathname) {
      if(!cordova) return;

      var roomName = pathname.substring(1);
      getIdForUri(roomName, function(err, id) {
        if(err || !id) return;

        updateNativeContext(id, roomName);
        window.location.href = '/mobile/chat#' + id;
      });
    },
    syncNativeWithWebContext: function(troupe) {
      if(!cordova) return;

      troupe.on('change', function() {
        updateNativeContextWithTroupe(troupe);
      });

      updateNativeContextWithTroupe(troupe);
    }
  };

});
