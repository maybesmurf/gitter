'use strict';

const appEvents = require('gitter-web-appevents');
const restSerializer = require('../../serializers/rest-serializer');

module.exports = {
  create: function(/*model*/) {
    // no-op
  },

  update: async function(groupId, securityDescriptorModel) {
    const url = `/groups/${groupId}/security`;
    const strategy = restSerializer.SecurityDescriptorStrategy.full();
    const serializedSecurityDescriptor = await restSerializer.serializeObject(
      securityDescriptorModel,
      strategy
    );
    appEvents.dataChange2(url, 'update', serializedSecurityDescriptor, 'group.sd');
  },

  patch: function(groupId, patch) {
    const url = `/groups/${groupId}/security`;
    const patchMessage = {
      ...patch,
      groupId
    };
    appEvents.dataChange2(url, 'patch', patchMessage, 'group.sd');
  },

  remove: function(/*model*/) {
    // no-op
  },

  removeId: function(/*groupId*/) {
    // no-op
  }
};
