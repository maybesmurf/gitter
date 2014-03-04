/*jshint strict:true, undef:true, unused:strict, browser:true *//* global define:false */
define([
  'underscore',
  'marionette',
  'utils/context',
  'hbs!./tmpl/parentSelectView',
  'hbs!./tmpl/parentItemView',
  'views/controls/dropdown',
  'backbone'
], function(_, Marionette, context, template, itemTemplate, Dropdown, Backbone) {
  "use strict";

  var ItemModel = Backbone.Model.extend({
    idAttribute: "uri",
  });

  return Marionette.Layout.extend({
    events: {
      'focus @ui.input':    'show',
      'keydown @ui.input':  'keydown',
      'change @ui.input': 'change',
      'cut @ui.input': 'change',
      'paste @ui.input': 'change',
      'input @ui.input': 'change',
      'keypress @ui.input': 'keypress',
      'keyup @ui.input':    'keyup'
    },
    regions: {
      dropdownRegion: '#dd-region',
    },
    ui: {
      input: "input#input-parent"
    },

    template: template,
    initialize: function(options) {
      this.orgsCollection = options.orgsCollection;
      this.troupesCollection = options.troupesCollection;

      this.refilterInput = _.throttle(_.bind(this.refilterInput, this), 50);

      this.dropdownItems = new Backbone.Collection({ });
      this.dropdownItems.comparator = function(a, b) {
        function compare(a, b) {
          if(a === b) return 0;
          return a < b ? -1 : +1;
        }

        if(a.get('type') === 'org') {
          if(b.get('type') === 'org') {
            return compare(a.get('name').toLowerCase(), b.get('name').toLowerCase());
          } else {
            return -1;
          }
        } else {
          if(b.get('type') === 'org') {
            return 1;
          }
        }

        return compare(a.get('name').toLowerCase(), b.get('name').toLowerCase());
      };

      this.dropdown = new Dropdown({ collection: this.dropdownItems, itemTemplate: itemTemplate });

      this.listenTo(this.dropdown, 'selected', this.selected);

      this.listenTo(this.orgsCollection, 'add remove change reset sync', this.reset);
      this.listenTo(this.troupesCollection, 'add remove change reset sync', this.reset);
    },

    selected: function(m) {
      this.ui.input.val(m.get('uri'));
      this.dropdown.hide();

      this.trigger('selected', m);
    },

    onRender: function() {
      this.dropdownRegion.show(this.dropdown);
    },

    reset: function() {
      var query = this.ui.input.val();
      this.refilter(query);
    },

    keyup: function(e) {
      if(e.keyCode === 27) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    },

    change: function() {
      var self = this;
      this.dropdown.show();

      setTimeout(function() {
        self.refilterInput();
      }, 1);
    },

    keydown: function(e) {
      switch(e.keyCode) {
        case 13:
          this.dropdown.select();
          break;

        case 38:
          this.dropdown.selectPrev();
          break;

        case 40:
          this.dropdown.show();
          this.dropdown.selectNext();
          break;

        case 27:
          this.dropdown.hide();
          break;

        default:
          return;
      }

      e.stopPropagation();
      e.preventDefault();
    },

    show: function() {
      this.dropdown.show();
      this.refilterInput();
    },

    hide: function() {
      // this.dropdown.hide();
    },

    refilterInput: function() {
      var query = this.ui.input.val();
      this.refilter(query);
    },
    refilter: function(query) {
      var self = this;
      var results;
      var select;

      if(!query) {
        results = defaultResults();
      } else {
        query = query.toLowerCase();

        if(query.indexOf('/') >= 0) {
          results = this.troupesCollection.filter(function(troupe) {
              return troupe.get('githubType') === 'REPO' && troupe.get('uri').toLowerCase().indexOf(query) === 0;
            }).map(function(m) {
              return {
                uri: m.get('uri'),
                name: m.get('name'),
                type: 'repo',
                repoType: true
              };
            });
        } else {
          results = defaultResults();
          select = results.filter(function(r) {
            return r.name.toLowerCase().indexOf(query) === 0;
          })[0];
        }
      }

      this.dropdownItems.set(results.map(function(m) {
        return new ItemModel(m);
      }), { add: true, remove: true, merge: true });

      if(select) {
        // this.dropdown.chooseModel(select);
      }

      function defaultResults() {
        var user = context.user();

        return self.orgsCollection.filter(function(m) {
          return !!m.get('room');
        }).map(function(a) {
          return {
            uri: a.get('room').uri,
            name: a.get('name'),
            avatarUrl: a.get('avatar_url'),
            type: 'org',
            orgType: true
          };
        }).concat({
          uri: user.get('username'),
          name: user.get('username'),
          avatarUrl: user.get('avatarUrlSmall'),
          type: 'user',
          userType: true
        });
      }
    }

  });

});
