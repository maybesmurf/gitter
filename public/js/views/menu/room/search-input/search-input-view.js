//TODO TEST THIS JP 10/2/16
'use strict';

var Marionette         = require('backbone.marionette');
var _                  = require('underscore');
var cocktail           = require('cocktail');
var KeyboardEventMixin = require('views/keyboard-events-mixin');
var template           = require('./search-input-view.hbs');
var toggleClass        = require('utils/toggle-class');
var RAF                = require('utils/raf');

var SearchInputView = Marionette.ItemView.extend({

  template: template,
  className: 'left-menu-search empty',

  ui: {
    clear: '.js-search-clear',
    input: 'input',
  },

  events: {
    'change':          'onInputChange',
    'input':           'onInputChange',
    'click @ui.clear': 'onClearClicked',
  },

  modelEvents: {
    'change:state':      'onModelChangeState',
    'change:searchTerm': 'onModelChangeSearchTerm',
  },

  keyboardEvents: {
    'room-list.start-nav': 'focusSearchInput',
  },

  initialize: function(attrs) {
    this.bus = attrs.bus;
    this.listenTo(this.bus, 'left-menu:recent-search', this.onRecentSearchUpdate, this);
  },

  onInputChange: _.debounce(function(e) {
    e.preventDefault();
    var val = e.target.value.trim();

    //This is here and not in a model change event because of the debounce
    //Obviously the styles need to change more quickly to give a responsive feel to thr ui
    //JP 10/2/16
    toggleClass(this.el, 'empty', !val);
    this.model.set('searchTerm', val);
  }, 500),

  onModelChangeState: function (model, val){ //jshint unused: true
    toggleClass(this.el, 'active', val === 'search');

    // Don't ruin the minibar navigation when using a keyboard
    if(model.get('activationSourceType') !== 'keyboard') {
      this.focusSearchInput();
    }
  },

  onRender: function (){
    this.onModelChangeState(this.model, this.model.get('state'));
  },

  onModelChangeSearchTerm: function(model, val) { //jshint unused: true
    if(val === '') { this.ui.input.val(val); }
    toggleClass(this.el, 'empty', !val);
  },

  onClearClicked: function(e) {
    e.preventDefault();
    this.model.set('searchTerm', '');
  },

  onRecentSearchUpdate: function (val){
    this.ui.input.val(val);
  },

  focusSearchInput: function() {
    var state = this.model.get('state');
    //We need to check if the ui elements have been bound
    //as this is a string before it is bounce we can't check [0] || .length
    //so we will check for the find function JP 15/3/16
    if(state === 'search') {
      RAF(function(){
        this.ui.input.focus();
      }.bind(this));
    }
  }

});

cocktail.mixin(SearchInputView, KeyboardEventMixin);


module.exports = SearchInputView;
