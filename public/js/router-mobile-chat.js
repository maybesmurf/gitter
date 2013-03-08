/*jshint unused:true, browser:true */
require([
  'jquery',
  'underscore',
  'backbone',
  'views/base',
  'collections/chat',
  'views/chat/chatInputView',
  'views/chat/chatCollectionView',
  'views/widgets/avatar',
  'components/unread-items-client',
  'scrollfix'
], function($, _, Backbone, TroupeViews, chatModels, ChatInputView, ChatCollectionView, AvatarWidget/*, unreadItemsClient, scrollfix*/) {
  /*jslint browser: true, unused: true */
  "use strict";

  TroupeViews.preloadWidgets({
    avatar: AvatarWidget
  });

    // Setup the ChatView
  var chatCollection = new chatModels.ChatCollection();
  chatCollection.listen();
  chatCollection.reset(window.troupePreloads['chatMessages'], { parse: true });

  $(function() {
    console.log("Checking if the collection needs to be fetched.", window.applicationCache.status);
    if (window.applicationCache.status == 1 /* NOUPDATE */) {
      console.log('Fetching collection.');
      chatCollection.fetch();
    }
  });

  new ChatInputView({
    el: $('#chat-input'),
    collection: chatCollection
  }).render();

  new ChatCollectionView({
    el: $('#frame-chat'),
    collection: chatCollection
  }).render();


// Prevent Header & Footer From Showing Browser Chrome

document.addEventListener('touchmove', function(event) {
   if(event.target.parentNode.className.indexOf('noBounce') != -1 || event.target.className.indexOf('noBounce') != -1 ) {
  event.preventDefault(); }
}, false);

// Add ScrollFix
var scrollingContent = document.getElementById("chat-wrapper");
new ScrollFix(scrollingContent);

  // Asynchronously load tracker
  require([
    'utils/tracking'
  ], function() {
    // No need to do anything here
  });

});
