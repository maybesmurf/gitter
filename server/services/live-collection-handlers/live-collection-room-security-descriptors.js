'use strict';

const appEvents = require('gitter-web-appevents');
const restSerializer = require('../../serializers/rest-serializer');

module.exports = {
  create: function(/*model*/) {
    // no-op
  },

  update: async function(roomId, securityDescriptorModel) {
    const url = `/rooms/${roomId}/security`;
    const strategy = restSerializer.SecurityDescriptorStrategy.full();
    const serializedSecurityDescriptor = await restSerializer.serializeObject(
      securityDescriptorModel,
      strategy
    );
    appEvents.dataChange2(url, 'update', serializedSecurityDescriptor, 'room.sd');
  },

  patch: function(roomId, patch) {
    const url = `/rooms/${roomId}/security`;
    const patchMessage = {
      ...patch
      //roomId
    };
    appEvents.dataChange2(url, 'patch', patchMessage, 'room.sd');
  },

  remove: function(/*model*/) {
    // no-op
  },

  removeId: function(/*roomId*/) {
    // no-op
  }
};
