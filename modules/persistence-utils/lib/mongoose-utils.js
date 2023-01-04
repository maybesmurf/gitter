'use strict';

const assert = require('assert');
var _ = require('lodash');
var Promise = require('bluebird');
var mongoose = require('gitter-web-mongoose-bluebird');
var mongoUtils = require('./mongo-utils');
var uniqueIds = require('mongodb-unique-ids');
var mongoReadPrefs = require('./mongo-read-prefs');

var Schema = mongoose.Schema;

function idsIn(ids) {
  return uniqueIds(ids).filter(function(id) {
    return !!id;
  });
}

function cloneSchema(schema) {
  const tree = _.extend({}, schema.tree);
  delete tree.id;
  delete tree._id;

  const clone = new Schema(tree);
  clone._indexes = [].concat(schema._indexes);

  return clone;
}

function hashList(list) {
  if (!list) return null;

  return list.reduce(function(memo, item) {
    memo[item] = true;
    return memo;
  }, {});
}

function attachNotificationListenersToSchema(schema, options) {
  var denylistHash = hashList(options.ignoredPaths);
  var allowlistHash = hashList(options.listenPaths);

  if (denylistHash && allowlistHash) {
    throw new Error(
      'Please specify either ignoredPaths (Denylist) or listenPaths (Allowlist) or neither, not both'
    );
  }

  function canIgnore(model) {
    var modified = model.modifiedPaths();
    if (modified.length === 0) {
      return true; // No changes
    }

    if (denylistHash) {
      var allDenied = modified.every(function(path) {
        return denylistHash[path];
      });
      if (allDenied) {
        return true; // All modified paths can be ignored
      }
      return false;
    }

    if (allowlistHash) {
      var someAllowed = modified.some(function(path) {
        return allowlistHash[path];
      });
      if (someAllowed) {
        return false; // Things on the Allowlist - handle this modification
      } else {
        return true; // Nothing on the Allowlist, ignore
      }
    }

    return false;
  }

  if (options.onCreate || options.onUpdate) {
    schema.pre('save', function(next) {
      if (canIgnore(this)) {
        return next();
      }

      var isNewInstance = this.isNew;

      if (this._skipTroupeMiddleware) {
        delete this._skipTroupeMiddleware;
        return next();
      }

      this._gIsNew = isNewInstance;
      next();
    });

    schema.post('save', function(doc, postNext) {
      var isNewInstance = doc._gIsNew;
      delete doc._gIsNew;
      if (isNewInstance) {
        if (options.onCreate) return options.onCreate(doc, postNext);
      } else {
        if (options.onUpdate) return options.onUpdate(doc, postNext);
      }
      return postNext();
    });
  }

  if (options.onRemove) {
    schema.post('remove', function(model, next) {
      options.onRemove(model);
      next();
    });
  }
}

var MAX_UPSERT_ATTEMPTS = 2;
var MONGO_DUPLICATE_KEY_ERROR = 11000;

/**
 * Performs a safe upsert,
 * returns an Promise of a boolean indicating
 * that the document already exists
 *   - true: means the query matched an existing document
 *   - false: means a new document was inserted
 */
function leanUpsert(schema, query, setOperation) {
  var attempts = 0;

  function performUpdate() {
    attempts++;
    return schema
      .findOneAndUpdate(query, setOperation, { upsert: true, new: false })
      .exec()
      .catch(function(err) {
        if (attempts >= MAX_UPSERT_ATTEMPTS) throw err;
        if (!mongoUtils.isMongoError(err)) throw err;
        if (err.code !== MONGO_DUPLICATE_KEY_ERROR) throw err;

        return performUpdate();
      });
  }

  return performUpdate().then(function(doc) {
    return !!doc;
  });
}

/**
 * Performs a safe upsert,
 * returns an Promise of the mongodb update result
 */
function safeUpsertUpdate(schema, query, setOperation) {
  var attempts = 0;

  function performUpdate() {
    attempts++;
    return schema
      .update(query, setOperation, { upsert: true })
      .exec()
      .catch(function(err) {
        if (attempts >= MAX_UPSERT_ATTEMPTS) throw err;
        if (!mongoUtils.isMongoError(err)) throw err;
        if (err.code !== MONGO_DUPLICATE_KEY_ERROR) throw err;

        return performUpdate();
      });
  }

  return performUpdate();
}

/*
 * Returns a promise [document, updatedExisting]
 * If mongo experiences a contention where it tries to
 * perform an insert but looses the battle to another
 * insert, this function will retry
 */
function upsert(schema, query, setOperation) {
  return leanUpsert(schema, query, setOperation).then(function(existing) {
    // If doc is null then an insert occurred
    return Promise.all([schema.findOne(query).exec(), existing]);
  });
}

/**
 * Returns a promise of documents
 */
function findByIds(Model, ids, { read } = {}) {
  return Promise.try(function() {
    if (!ids || !ids.length) return [];

    /* Special case for a single ID */
    if (ids.length === 1) {
      return Model.findById(ids[0])
        .read(read)
        .exec()
        .then(function(doc) {
          if (doc) return [doc];
          return [];
        });
    }

    /* Usual case */
    return Model.where('_id')
      ['in'](mongoUtils.asObjectIDs(idsIn(ids)))
      .read(read)
      .exec();
  });
}

/**
 * Returns a promise of lean documents
 */
function findByIdsLean(Model, ids, select) {
  return Promise.try(function() {
    if (!ids || !ids.length) return [];

    /* Special case for a single ID */
    if (ids.length === 1) {
      return Model.findById(ids[0], select, { lean: true })
        .exec()
        .then(function(doc) {
          if (doc) return [mongoUtils.setId(doc)];
          return [];
        });
    }

    /* Usual case */
    return Model.where('_id')
      .in(mongoUtils.asObjectIDs(idsIn(ids)))
      .select(select)
      .lean()
      .exec()
      .then(mongoUtils.setIds);
  });
}

function addIdToLean(object) {
  if (object && object._id) {
    object.id = object._id.toString();
  }
  return object;
}

function addIdToLeanArray(objects) {
  if (objects) {
    objects.forEach(function(f) {
      if (f && f._id) {
        f.id = f._id.toString();
      }
    });
  }
  return objects;
}

function getEstimatedCountForId(Model, field, id, options) {
  options = options || {};
  options.read = options.read || mongoReadPrefs.secondaryPreferred;

  var query = {};
  query[field] = id;
  return Model.count(query)
    .read(options.read)
    .exec();
}

function getEstimatedCountForIds(Model, field, ids, options) {
  options = options || {};
  options.read = options.read || mongoReadPrefs.secondaryPreferred;

  if (!ids || !ids.length) return {};

  if (ids.length === 1) {
    var singleId = ids[0];
    return getEstimatedCountForId(Model, field, singleId).then(function(count) {
      var hash = {};
      hash[singleId] = count;
      return hash;
    });
  }

  var query = {};
  query[field] = { $in: ids };
  return Model.aggregate([
    {
      $match: query
    },
    {
      $group: {
        _id: '$' + field,
        count: { $sum: 1 }
      }
    }
  ])
    .read(options.read)
    .exec()
    .then(function(results) {
      if (!results || !results.length) return {};

      return _.reduce(
        results,
        function(memo, result) {
          memo[result._id] = result.count;
          return memo;
        },
        {}
      );
    });
}

function makeLastModifiedUpdater(Model) {
  return function(id, lastModified) {
    var query = {
      _id: id
    };
    var update = {
      $max: {
        lastModified: lastModified
      }
    };
    return Model.update(query, update).exec();
  };
}

async function* iterableFromMongooseCursor(cursor) {
  let doc = await cursor.next();
  while (doc !== null) {
    yield doc;
    doc = await cursor.next();
  }
}

// The default cursor timeout is 600,000ms (10 minutes)
const MONGO_CURSOR_TIMEOUT_MS = 600000;
// How much time can be left on the cursor before we try creating a new one
const CURSOR_TIMEOUT_SAFE_THRESHOLD_MS = 3 * 60 * 1000;

// Creates an iterable that strives to pre-emptively avoid cursor timeout or cursor not
// found errors. Will create a new cursor any time we try to iterate with a cursor that
// has timed out or is about to time out.
//
// ex.
// ```
// const gitterRoomStreamIterable = noTimeoutIterableFromMongooseCursor(({ resumeCursorFromId }) => {
//   const gitterRoomCursor = persistence.Troupe.find({
//     _id: (() => {
//       const idQuery = {};
//       if (resumeCursorFromId) {
//         idQuery['$gt'] = resumeCursorFromId;
//       } else {
//         idQuery['$exists'] = true;
//       }
//
//       return idQuery;
//     })()
//   })
//     .lean()
//     .read(mongoReadPrefs.secondaryPreferred)
//     .batchSize(20)
//     .cursor();
//
//   return gitterRoomCursor;
// });
// ```
//
// XXX: Should this just be the default implementation of `iterableFromMongooseCursor`?
// We would need to refactor those usages to give us a function that creates the cursor.
async function* noTimeoutIterableFromMongooseCursor(cursorCreationCb) {
  assert(typeof cursorCreationCb === 'function');

  // We record the time just before creating the cursor instead of after for extra
  // safety in case there is a large pause between when the cursor is actually created
  // in the database vs when we move on here (also keep in mind GC pauses, etc -
  // Designing data-intentsive applications, Martin Kleppmann);
  let cursorCreationTs = Date.now();
  let cursor = cursorCreationCb({ resumeCursorFromId: null });

  let doc = await cursor.next();
  while (doc !== null) {
    yield doc;

    // If it has been too long, create a new cursor
    if (
      Date.now() - cursorCreationTs >=
      MONGO_CURSOR_TIMEOUT_MS - CURSOR_TIMEOUT_SAFE_THRESHOLD_MS
    ) {
      cursorCreationTs = Date.now();
      cursor = cursorCreationCb({ resumeCursorFromId: doc.id || doc._id });
    }

    doc = await cursor.next();
  }
}

module.exports = {
  attachNotificationListenersToSchema: attachNotificationListenersToSchema,
  leanUpsert: leanUpsert,
  safeUpsertUpdate: safeUpsertUpdate,
  upsert: upsert,
  findByIds: findByIds,
  findByIdsLean: findByIdsLean,
  addIdToLean: addIdToLean,
  addIdToLeanArray: addIdToLeanArray,
  cloneSchema: cloneSchema,
  getEstimatedCountForId: getEstimatedCountForId,
  getEstimatedCountForIds: getEstimatedCountForIds,
  makeLastModifiedUpdater: makeLastModifiedUpdater,
  iterableFromMongooseCursor,
  noTimeoutIterableFromMongooseCursor
};
