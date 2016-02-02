'use strict';

var Backbone = require('backbone');

module.exports = Backbone.Model.extend({
  defaults: {
    tertiaryCollectionActive: false,
    tertiaryCollectionHeader: 'Your Organisations',
  },
  initialize: function(attrs, options) { //jshint unused: true

    if (!options || !options.model) {
      throw new Error('Avalid instance of RoomMenuModel must be passed to a new instance of TertiaryCollectionModel');
    }

    this.model = options.model;
    this.listenTo(this.model, 'change:state', this.onModelChangeState, this);
  },

  onModelChangeState: function(model, val) { //jshint unused: true
    switch (val) {
      case 'all':
        this.set({
          tertiaryCollectionHeader: 'Your Organisations',
          tertiaryCollectionActive: true,
        });
        break;
      case 'search':
        this.set({
          tertiaryCollectionHeader: 'Recent Searches',
          tertiaryCollectionActive: true,
        });
        break;
      default:
        this.set({
          tertiaryCollectionHeader: ' ',
          tertiaryCollectionActive: false,
        });
        break;
    }
  },

});
