/* jshint node:true */
"use strict";

var winston = require('./winston');
var ObjectID = require('mongodb').ObjectID;
var _ = require('underscore');

function asObjectID(id) {
  if(!id) {
    return null;
  }

  if(typeof id === 'string') {
    return new ObjectID(id);
  }

  return id;
}

function asObjectIDs(ids) {
  return ids.map(function(id) {
    return asObjectID(id);
  });
}

function getDateFromObjectId(id) {
  if(!id) {
    winston.silly('Null ID passed into getDateFromObjectId.');
    return null;
  }

  if(typeof id === 'string') {
    var objectId = new ObjectID(id);
    return objectId.getTimestamp();
  }

  return id.getTimestamp();
}

function getTimestampFromObjectId(id) {
  var d = getDateFromObjectId(id);
  if(d) return d.getTime();

  return null;
}

function getNewObjectIdString() {
  var objectId = new ObjectID();
  return objectId.valueOf();
}

/**
 * Checks to see whether something is either a String or ObjectID (hence ObjectID-like)
 */
function isLikeObjectId(value) {
  // value instanceof Object doesn't always work, so we'll do something a bit more hacky
  if(!value) return false;

  if(value && value._bsontype === 'ObjectID' || value instanceof ObjectID) {
    return true;
  }

  if(typeof value === 'string' || value instanceof String) {
    // Avoid an expensive try-catch if possible
    if(value.length !== 24) return false;

    return (/^[0-9a-fA-F]{24}$/).test(value);
  }

  return false;
}


function serializeObjectId(id) {
  if(!id) return '';
  if(typeof id === 'string') {
    return id;
  }
  return id.toString();
}

function createIdForTimestamp(timestamp) {
    var hexSeconds = Math.floor(timestamp/1000).toString(16);
    while(hexSeconds.length < 8) {
      hexSeconds = "0" + hexSeconds;
    }
    return new ObjectID(hexSeconds + "0000000000000000");
}

function fieldInPredicate(fieldName, values, additionalClauses) {
  var predicate = {};
  if (values.length === 1) {
    predicate[fieldName] = values[0];
  } else {
    predicate[fieldName] = { $in: values };
  }

  return _.defaults(predicate, additionalClauses);
}

function setId(model) {
  model.id = serializeObjectId(model._id);
  return model;
}
exports.setId = setId;

function setIds(array) {
  array.forEach(function(f) {
    f.id = serializeObjectId(f._id);
  });
  return array;
}
exports.setIds = setIds;

exports.isLikeObjectId = isLikeObjectId;
exports.asObjectID = asObjectID;
exports.asObjectIDs = asObjectIDs;
exports.getDateFromObjectId = getDateFromObjectId;
exports.getTimestampFromObjectId = getTimestampFromObjectId;
exports.getNewObjectIdString = getNewObjectIdString;
exports.serializeObjectId = serializeObjectId;
exports.createIdForTimestamp = createIdForTimestamp;
exports.fieldInPredicate = fieldInPredicate;
