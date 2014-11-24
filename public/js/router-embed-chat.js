"use strict";
var ChatNliIntegratedView = require('views/app/chatNliIntegratedView');
var ChatCollectionView = require('views/chat/chatCollectionView');
var chatModels = require('collections/chat');
var webhookDecorator = require('views/chat/decorators/webhookDecorator');
var issueDecorator = require('views/chat/decorators/issueDecorator');
var commitDecorator = require('views/chat/decorators/commitDecorator');
var mentionDecorator = require('views/chat/decorators/mentionDecorator');
var embedDecorator = require('views/chat/decorators/embedDecorator');
var emojiDecorator = require('views/chat/decorators/emojiDecorator');
var HistoryLimitView = require('views/app/historyLimitView');
var onready = require('./utils/onready');

require('components/statsc');
require('views/widgets/preload');
require('components/dozy');
require('template/helpers/all');
require('components/bug-reporting');

// Preload widgets
require('views/widgets/avatar');
require('views/widgets/timeago');


onready(function() {
  new ChatNliIntegratedView({ el: 'body' });

  var chatCollection = new chatModels.ChatCollection(null, { listen: true });

  var chatCollectionView = new ChatCollectionView({
    el: '#chat-container',
    collection: chatCollection,
    // userCollection: itemCollections.users, // do we need the user collection?
    decorators: [webhookDecorator, issueDecorator, commitDecorator, mentionDecorator, embedDecorator, emojiDecorator],
  }).render();

  chatCollection.on('add', function (item) {
    setTimeout(item.set.bind(item, 'unread', false), 500);
  });

  new HistoryLimitView({
    el: '#limit-banner',
    collection: chatCollection,
    chatCollectionView: chatCollectionView
  }).render();


});
