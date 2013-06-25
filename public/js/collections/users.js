/*jshint strict:true, undef:true, unused:strict, browser:true *//* global define:false */
define([
  'jquery',
  'underscore',
  'backbone',
  './base'
], function($, _, Backbone, TroupeCollections) {
  "use strict";

  var exports = {};

  exports.UserModel = TroupeCollections.Model.extend({
    idAttribute: "id",

    defaults: {
    },

    initialize: function() {
    }

  });

  exports.UserCollection = TroupeCollections.LiveCollection.extend({
    model: exports.UserModel,
    modelName: 'user',
    nestedUrl: "users",
    preloadKey: "users"
  });

  return exports;

});
