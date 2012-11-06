// Filename: views/home/main
define([
  'jquery',
  'underscore',
  'backbone',
  'views/base',
  'hbs!./versionView'
], function($, _, Backbone, TroupeViews, template){
  return TroupeViews.Base.extend({
    template: template,

    events: {
    },

    initialize: function(options) {
    },

    afterRender: function() {
    },

    beforeClose: function() {
    },

    getRenderData: function() {
      var data = this.model.toJSON();
      data.createdDate = data.createdDate ? data.createdDate.calendar() : null;
      return data;
    }

  });
});
