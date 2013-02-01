/*jshint unused:true browser:true*/

define([
  'jquery',
  'underscore',
  'backbone',
  'views/base',
  'hbs!./tmpl/conversationView',
  'collections/conversations',
  'views/conversation/conversationItemView'
], function($, _, Backbone, TroupeViews, template, conversationModels, ConversationItemView){
  "use strict";

  function makeSort(sortField) {
    return function(e) {
      e.preventDefault();
      this.collectionView.sortBy(sortField);
    };
  }

  return TroupeViews.Base.extend({
    template: template,

    initialize: function(options) {
      _.bindAll(this, 'showSortMenu', 'hideSortMenu');
    },

    events: {
      "click .link-sort-from": makeSort('from'),
      "click .link-sort-date": makeSort('date'),
      "click .link-sort-subject": makeSort('subject'),
      "click .mail-sorter": "showSortMenu"
    },

    getRenderData: function() {
      // we probably want to pull in the domain from config, e.g. for beta.trou.pe
      var emailAddress = window.troupeContext.troupe.uri + '@' + window.troupeContext.baseServer;
      var troupeName = window.troupeContext.troupe.name;
      troupeName = troupeName.replace(/\s/g,"%20");
      return { "emailAddress" : emailAddress, "troupeName" : troupeName };

    },

    afterRender: function() {
      this.collectionView = new TroupeViews.Collection({
        itemView: ConversationItemView,
        collection: this.collection,
        el: this.$el.find(".frame-conversations"),
        noItemsElement: this.$el.find("#frame-help"),
        sortMethods: {
          "from": function(conversation) {
            var lastSender = conversation.get('lastSender');
            if(!lastSender) return null;
            return lastSender.displayName;
          },
          "subject": function(conversation) {
            var fileName = conversation.get('subject');
            return fileName ? fileName.toLowerCase() : '';
          },
          "date": function(conversation) {
            return conversation.get("updated");
          }
        }
      }).render();
    },

    showSortMenu: function(e) {
      $('body, html').on('click', this.hideSortMenu);
      this.$el.find(".trpSortMenu").fadeIn('fast');
      return false;
    },

    hideSortMenu: function(e) {
      var self = this;
      $('body, html').off('click', this.hideSortMenu);
      this.$el.find('.trpSortMenu').fadeOut('fast');
    }

  });

});
