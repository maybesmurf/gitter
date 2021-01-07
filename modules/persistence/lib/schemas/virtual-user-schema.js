'use strict';

var mongoose = require('gitter-web-mongoose-bluebird');
var Schema = mongoose.Schema;

const VirtualUserSchema = new Schema({
  type: {
    type: String,
    require: true
  },
  externalId: {
    type: String,
    require: true
  },
  displayName: {
    type: String,
    require: true
  },
  avatarUrl: {
    type: String,
    require: false
  }
});
VirtualUserSchema.schemaTypeName = 'VirtualUserSchema';
VirtualUserSchema.index({ type: 1, externalId: 1 }, { background: true });

module.exports = {
  VirtualUserSchema
  // install
};
