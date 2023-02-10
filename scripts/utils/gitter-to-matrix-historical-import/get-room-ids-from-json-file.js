'use strict';

const env = require('gitter-web-env');
const logger = env.logger;

function getRoomIdsFromJsonFile(roomIdsFromJsonListFilePath) {
  let gitterRoomIds;
  if (roomIdsFromJsonListFilePath) {
    const jsonContentFromFile = require(roomIdsFromJsonListFilePath);
    if (!Array.isArray(jsonContentFromFile)) {
      throw new Error(
        `roomIdsFromJsonListFilePath=${roomIdsFromJsonListFilePath} was unexpectedly not a JSON array`
      );
    }

    if (jsonContentFromFile.length === 0) {
      logger.warn(
        `Nothing to process from roomIdsFromJsonListFilePath=${roomIdsFromJsonListFilePath} since it was an empty array`
      );
      return;
    }

    if (typeof jsonContentFromFile[0] === 'string') {
      gitterRoomIds = jsonContentFromFile;
    } else if (typeof jsonContentFromFile[0] === 'object') {
      gitterRoomIds = jsonContentFromFile.map(entry => {
        return entry.id || entry._id;
      });
    } else {
      throw new Error(
        `roomIdsFromJsonListFilePath=${roomIdsFromJsonListFilePath} must be an array of strings or an array of objects with an "id" property`
      );
    }
  }

  return gitterRoomIds;
}

module.exports = getRoomIdsFromJsonFile;
