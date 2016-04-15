'use strict';

var Marionette                      = require('backbone.marionette');
var toggleClass                     = require('utils/toggle-class');
var cocktail                        = require('cocktail');
var KeyboardEventMixin              = require('views/keyboard-events-mixin');
var template                        = require('./base-collection-item-view.hbs');
var updateUnreadIndicatorClassState = require('../../../../components/menu/update-unread-indicator-class-state');

var BaseCollectionItemView = Marionette.ItemView.extend({

  className: 'room-item',
  template:  template,

  triggers: {
    'click': 'item:activated',
  },

  keyboardEvents: {
    'room-list-item:activate': 'onItemActivated',
  },

  modelEvents: {
    'change:active': 'onActiveChange',
    'change:focus':    'onItemFocused',
    'change:unreadItems change:mentions change:activity': 'onUnreadUpdate',
    'focus:item': 'focusItem',
    'blur:item': 'blurItem'
  },

  ui: {
    container: '#room-item__container',
    unreadIndicator: '.room-item__unread-indicator'
  },

  constructor: function(attrs) {
    this.roomMenuModel = attrs.roomMenuModel;
    this.index         = attrs.index;
    Marionette.ItemView.prototype.constructor.apply(this, arguments);
  },

  attributes: function() {
    //TODO specialise this to be data-*-id eg data-room-id
    return {
      'data-id': this.model.get('id'),
    };
  },

  pulseIndicators: function() {
    // Re-trigger the pulse animation
    // 16ms is a good 60-fps number to trigger on which Firefox needs (requestAnimationFrame doesn't work for this)
    Array.prototype.forEach.call(this.ui.unreadIndicator, function(unreadIndicatorElement) {
    unreadIndicatorElement.style.animation = 'none';
      setTimeout(function() {
          unreadIndicatorElement.style.animation = '';
      }, 16);
    });
  },

  onActiveChange: function(model, val) { //jshint unused: true
    console.log('base-collection-item-view--onActiveChange', val);
    toggleClass(this.ui.container[0], 'active', !!val);
  },

  onItemActivated: function(e) {
    this.trigger('item:activated', this);
    console.log('onItemActivated', this);
    e.preventDefault();
  },

  onItemFocused: function(model, val) {//jshint unused: true
    toggleClass(this.ui.container[0], 'focus', !!val);
  },

  onUnreadUpdate: function() {
    updateUnreadIndicatorClassState(this.model, this.ui.unreadIndicator);

    // Update the count inside the badge indicator
    var unreadIndicatorContent = '';
    var unreads = this.model.get('unreadItems');
    var mentions = this.model.get('mentions');
    if(mentions === 0 && unreads > 0) {
      unreadIndicatorContent = unreads;
    }
    Array.prototype.forEach.call(  this.ui.unreadIndicator, function(indicatorElement) {
      indicatorElement.innerHTML = unreadIndicatorContent;
    });

    this.pulseIndicators();
  },

  focusItem: function() {
    console.log('focusItem', this);
    this.ui.container.focus();
    this.ui.container.addClass('focus');
  },

  blurItem: function() {
    console.log('blurItem', this);
    this.ui.container.blur();
    this.ui.container.removeClass('focus');
  }

});


cocktail.mixin(BaseCollectionItemView, KeyboardEventMixin);


module.exports = BaseCollectionItemView;
