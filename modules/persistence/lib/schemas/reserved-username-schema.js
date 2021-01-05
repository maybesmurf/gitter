'use strict';

const mongoose = require('gitter-web-mongoose-bluebird');
const Schema = mongoose.Schema;

const ReservedUsernameSchema = new Schema(
  {
    username: { type: String, required: true },
    lcUsername: {
      type: String,
      default: function() {
        return this.username ? this.username.toLowerCase() : null;
      }
    }
  },
  { strict: 'throw' }
);

ReservedUsernameSchema.schemaTypeName = 'ReservedUsernameSchema';
ReservedUsernameSchema.index({ username: 1 }, { unique: true, sparse: true });
ReservedUsernameSchema.index({ lcUsername: 1 }, { unique: true, sparse: true });

module.exports = {
  install: function(mongooseConnection) {
    const Model = mongooseConnection.model('ReservedUsername', ReservedUsernameSchema);

    return {
      model: Model,
      schema: ReservedUsernameSchema
    };
  }
};
