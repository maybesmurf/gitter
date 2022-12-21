'use strict';

const mongoose = require('gitter-web-mongoose-bluebird');
const Schema = mongoose.Schema;

// This is the same as the `MatrixBridgedRoomSchema` but we just track the historical
// rooms where we have imported all the history separately
const MatrixBridgedHistoricalRoomSchema = new Schema(
  {
    troupeId: { type: Schema.ObjectId, required: true },
    matrixRoomId: { type: String, required: true }
  },
  { strict: 'throw' }
);

MatrixBridgedHistoricalRoomSchema.schemaTypeName = 'MatrixBridgedHistoricalRoomSchema';
MatrixBridgedHistoricalRoomSchema.index({ troupeId: 1 }, { unique: true, sparse: true });
MatrixBridgedHistoricalRoomSchema.index({ matrixRoomId: 1 }, { unique: true, sparse: true });

module.exports = {
  install: function(mongooseConnection) {
    const Model = mongooseConnection.model(
      'MatrixBridgedHistoricalRoom',
      MatrixBridgedHistoricalRoomSchema
    );

    return {
      model: Model,
      schema: MatrixBridgedHistoricalRoomSchema
    };
  }
};
