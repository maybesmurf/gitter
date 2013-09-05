/*jshint strict:true, undef:true, unused:strict, browser:true *//* global define:false */
define([
  'jquery',
  'utils/context',
  'views/base',
  'utils/appevents',
  'hbs!./tmpl/chatInputView',
  'utils/momentWrapper',
  'utils/safe-html',
  'jquery-placeholder' // No ref
], function($, context, TroupeViews, appEvents, template, moment, safeHtml) {
  "use strict";

  var ChatInputView = TroupeViews.Base.extend({
    template: template,

    getRenderData: function() {
      return {
        user: context.getUser()
      };
    },

    afterRender: function() {
      this.inputBox = new ChatInputBoxView({
        el: this.$el.find('.trpChatInputBoxTextArea'),
      });

      this.listenTo(this.inputBox, 'save', this.send);
    },

    send: function(val) {
      if(val) {
        var model = this.collection.create({
          text: val,
          fromUser: context.getUser(),
          sent: moment()
        });
        appEvents.trigger('chat.send', model);
      }
      return false;
    }
  });

  var chatPadding = parseInt($('#frame-chat').css('padding-bottom'),10);
  var originalChatPadding = chatPadding;

  var ChatInputBoxView = TroupeViews.Base.extend({

    events: {
      "keyup": "detectNewLine",
      "keydown":  "detectReturn",
      "focusout": "onFocusOut"
    },

    // pass in the textarea as el for ChatInputBoxView
    // pass in a scroll delegate
    initialize: function() {
      this.chatLines = 2;

      this.originalChatInputHeight = this.$el.height();
      this.$el.placeholder();

      this.resizeInput();
    },

    onFocusOut: function() {
      if (this.compactView) this.send();
    },

    resetInput: function() {
      this.chatLines = 2;
      chatPadding = originalChatPadding;
      this.$el.height(this.originalChatInputHeight);
      $('#frame-chat').css('padding-bottom', chatPadding);

    },

    resizeInput: function() {
      var lht = parseInt(this.$el.css('lineHeight'),10);
      var height = this.$el.prop('scrollHeight');
      var currentLines = Math.floor(height / lht);

      if (currentLines != this.chatLines) {
        this.chatLines = currentLines;
        var newHeight = currentLines * lht;

        this.$el.height(newHeight);
        var frameChat = $('#frame-chat'), isChild = frameChat.find(this.el).length;
        if (!isChild) {
          chatPadding = originalChatPadding + Math.abs(this.originalChatInputHeight - newHeight);
          frameChat.css('padding-bottom', chatPadding);
        }

        chatPadding = originalChatPadding + Math.abs(this.originalChatInputHeight - newHeight);
      }
    },

    detectNewLine: function(e) {
      if (e.keyCode ==13 && (e.ctrlKey || e.shiftKey)) {
        if (window._troupeCompactView !== true) this.resizeInput();
      }
    },

    detectReturn: function(e) {
      if(e.keyCode == 13 && (!e.ctrlKey && !e.shiftKey) && (!this.$el.val().match(/^\s+$/))) {
        if (window._troupeCompactView !== true) this.resetInput();
        e.stopPropagation();
        e.preventDefault();

        this.send();
        return;
      }

      if (window._troupeCompactView !== true) this.resizeInput();
    },

    send: function() {
      this.trigger('save', safeHtml(this.$el.val()));

      this.$el.val('');
    }
  });

  return { ChatInputView: ChatInputView, ChatInputBoxView: ChatInputBoxView };
});
