'use strict';

var Marionette = require('backbone.marionette');

var CommunityCreationRepoListTemplate = require('./community-creation-repo-list-view.hbs');
var CommunityCreationRepoListEmptyTemplate = require('./community-creation-repo-list-empty-view.hbs');
var CommunityCreationRepoListItemView = require('./community-creation-repo-list-item-view');


var CommunityCreationRepoListEmptyView = Marionette.ItemView.extend({
  template: CommunityCreationRepoListEmptyTemplate,
  ui: {
    emptyNote: '.community-create-repo-list-empty-note__text-empty',
    loadingNote: '.community-create-repo-list-empty-note__text-loading'
  },
  initialize: function() {
    this.listenTo(this.collection, 'request', this.onCollectionFetch.bind(this), this);
    this.listenTo(this.collection, 'reset sync snapshot', this.onCollectionDoneLoading.bind(this), this);
  },

  onCollectionFetch: function() {
    this.ui.emptyNote[0].classList.add('hidden');
    this.ui.loadingNote[0].classList.remove('hidden');
  },

  onCollectionDoneLoading: function() {
    this.ui.emptyNote[0].classList.remove('hidden');
    this.ui.loadingNote[0].classList.add('hidden');
  }
});

var CommunityCreationRepoListView = Marionette.CompositeView.extend({
  template: CommunityCreationRepoListTemplate,
  childView: CommunityCreationRepoListItemView,
  emptyView: CommunityCreationRepoListEmptyView,
  emptyViewOptions: function() {
    return {
      collection: this.collection
    };
  },
  childViewContainer: '.community-create-repo-list',
  childEvents: {
    'item:activated': 'onItemActivated'
  },

  initialize: function() {
  },

  onItemActivated: function(view) {
    var newActiveValue = !view.model.get('active');

    var previousActiveModel = this.collection.findWhere({ active: true });
    if(previousActiveModel) {
      previousActiveModel.set('active', false);
    }
    // Toggle active
    view.model.set('active', newActiveValue);
    if(newActiveValue) {
      this.trigger('repo:activated', view.model);
    }
    else {
      this.trigger('repo:cleared');
    }
  }
});

module.exports = CommunityCreationRepoListView;
