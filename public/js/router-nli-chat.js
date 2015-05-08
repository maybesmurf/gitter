"use strict";

var appEvents = require('utils/appevents');
var Backbone = require('backbone');
var context = require('utils/context');
var ChatNliIntegratedView = require('views/app/chatNliIntegratedView');
var itemCollections = require('collections/instances/integrated-items');
var userModels = require('collections/users');
var RightToolbarView = require('views/righttoolbar/rightToolbarView');
var peopleCollectionView = require('views/people/peopleCollectionView');
var HeaderView = require('views/app/headerView');
var onready = require('./utils/onready');
var highlightPermalinkChats = require('./utils/highlight-permalink-chats');

require('views/widgets/preload');
require('filtered-collection');
require('components/dozy');
require('template/helpers/all');
require('components/bug-reporting');

// Preload widgets
require('views/widgets/avatar');
require('views/widgets/timeago');
require('components/ping');

onready(function() {

  require('components/link-handler').installLinkHandler();

  appEvents.on('navigation', function(url) {
    // No pushState here. Open links within the parent...
    window.parent.location.href = url;
  });

  var appView = new ChatNliIntegratedView({ el: 'body', chatCollection: itemCollections.chats, userCollection: itemCollections.users });

  new HeaderView({ model: context.troupe(), el: '#header' });
  new RightToolbarView({ el: "#right-toolbar-layout" });

  var Router = Backbone.Router.extend({
    routes: {
      "": "hideModal",
      "people": "people",
    },

    hideModal: function() {
      appView.dialogRegion.close();
    },

    people: function() {
      var userCollection = new userModels.UserCollection();
      userCollection.fetch();

      appView.dialogRegion.show(new peopleCollectionView.Modal({ collection: userCollection }));
    },

  });

  new Router();

  // // Listen for changes to the room
  // liveContext.syncRoom();

  Backbone.history.start();

  if (context().permalinkChatId) {
    highlightPermalinkChats(appView.chatCollectionView, context().permalinkChatId);
  }

});
