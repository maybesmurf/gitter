'use strict';

var mongoose = require('gitter-web-mongoose-bluebird');
var Schema = mongoose.Schema;
var ObjectId = Schema.ObjectId;
var installVersionIncMiddleware = require('../install-version-inc-middleware');
const VirtualUserSchema = require('./virtual-user-schema').VirtualUserSchema;

var ChatMessageSchema = new Schema({
  fromUserId: {
    type: ObjectId,
    required: true
  },
  // The virtualUser field allows us to have outside bots/bridges emulate a user from another service
  // and bridge in the message so it looks nice and native with their own name and avatar
  virtualUser: {
    type: VirtualUserSchema,
    required: false
  },
  toTroupeId: ObjectId, //TODO: rename to troupeId
  parentId: ObjectId,
  text: String,
  status: { type: Boolean, required: false },
  threadMessageCount: { type: Number, required: false },
  pub: { type: Boolean, required: false }, // PUBLIC?
  html: String,
  urls: Array, // TODO: schema-ify this
  mentions: [
    {
      screenName: { type: String, required: true },
      userId: { type: ObjectId },
      userIds: { type: [ObjectId] },
      group: { type: Boolean, required: false }, // True iff screenname is a group
      announcement: { type: Boolean, required: false } // True iff screenname is an announcement
    }
  ],
  issues: Array, // TODO: schema-ify this
  meta: Schema.Types.Mixed,
  sent: { type: Date, default: Date.now },
  editedAt: { type: Date, default: null },
  readBy: { type: [ObjectId] },
  lang: String,
  _tv: { type: 'MongooseNumber', default: 0 },
  _md: Number // Meta parse version
});
ChatMessageSchema.index({ toTroupeId: 1, sent: -1 });
ChatMessageSchema.index({ threadMessageCount: 1 }, { background: true });
ChatMessageSchema.index({ parentId: 1, sent: -1 }, { background: true });
ChatMessageSchema.index({ fromUserId: 1 }, { background: true });
ChatMessageSchema.schemaTypeName = 'ChatMessageSchema';

installVersionIncMiddleware(ChatMessageSchema);

module.exports = {
  ChatMessageSchema: ChatMessageSchema,
  install: function(mongooseConnection) {
    var model = mongooseConnection.model('ChatMessage', ChatMessageSchema);

    return {
      model: model,
      schema: ChatMessageSchema
    };
  }
};
