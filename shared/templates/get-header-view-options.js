'use strict';

function getHeaderLinkUrl(serializedTroupe) {
  let backend = serializedTroupe.backend;
  if (!backend) return;

  // When the room security descriptor is referencing the group, use that security descriptor instead
  if (serializedTroupe.backend.type === 'GROUP') {
    backend = serializedTroupe.group.backedBy;
  }

  switch (backend.type) {
    case 'GL_GROUP':
      return 'https://gitlab.com/' + backend.linkPath;
    case 'GH_REPO':
    case 'GH_ORG':
      return 'https://github.com/' + backend.linkPath;
  }

  return;
}

function isTroupeAdmin(serializedTroupe) {
  return serializedTroupe.permissions && serializedTroupe.permissions.admin;
}

function getHeaderViewOptions(serializedTroupe) {
  var group = serializedTroupe.group;
  var groupUri = group && group.uri;
  var groupPageUrl = groupUri && '/orgs/' + groupUri + '/rooms';

  return {
    url: serializedTroupe.url,
    oneToOne: serializedTroupe.oneToOne,
    troupeName: serializedTroupe.name,
    favourite: serializedTroupe.favourite,
    premium: serializedTroupe.premium,
    isPrivate: !serializedTroupe.public,
    troupeTopic: serializedTroupe.topic,
    isAdmin: isTroupeAdmin(serializedTroupe),
    avatarUrl: serializedTroupe.avatarUrl,
    group: group,
    groupPageUrl: groupPageUrl,
    headerLink: getHeaderLinkUrl(serializedTroupe)
  };
}

module.exports = getHeaderViewOptions;
