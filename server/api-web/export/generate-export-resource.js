'use strict';

const Promise = require('bluebird');
const StatusError = require('statuserror');
const env = require('gitter-web-env');
const stats = env.stats;
const redisClient = env.redis.getClient();
const asyncHandler = require('express-async-handler');
const dolph = require('dolph');
const restSerializer = require('../../serializers/rest-serializer');

function generateExportResource(key, getCursor, getStrategy) {
  const rateLimiter = dolph({
    prefix: `export:${key}:`,
    redisClient: redisClient,
    // TODO: Reduce limit to 1 after we are done testing
    limit: process.env.TEST_EXPORT_RATE_LIMIT || 100,
    // 1 hours in seconds
    expiry: 1 * (60 * 60),
    keyFunction: function(req) {
      if (req.user) {
        if (req.authInfo && req.authInfo.client) {
          return req.user.id + ':' + req.authInfo.client.id;
        }

        return req.user.id;
      }

      // Anonymous access tokens
      if (req.authInfo && req.authInfo.accessToken) {
        return req.authInfo.accessToken;
      }

      // Should never get here
      return 'anonymous';
    }
  });

  return {
    id: key,
    respond: function(req, res) {
      res.end();
    },
    index: asyncHandler(async (req, res) => {
      try {
        stats.event(`api.export.${key}`, { userId: req.user && req.user.id });

        await new Promise((resolve, reject) => {
          rateLimiter(req, res, err => {
            if (err) {
              reject(err);
            }

            resolve();
          });
        });

        // TODO: Remove after we look at the CPU load from doing this with so many messages #no-staff-for-export
        const isStaff = req.user && req.user.staff;
        if (!isStaff) {
          throw new StatusError(403, 'Only staff can use the export endpoint right now');
        }

        if (req.accepts('application/x-ndjson') !== 'application/x-ndjson') {
          // Not Acceptable
          throw new StatusError(406);
        }

        const exportDate = new Date();
        const dateString = `${exportDate.getUTCFullYear()}-${exportDate.getUTCMonth() +
          1}-${exportDate.getUTCDate()}`;

        // https://github.com/ndjson/ndjson-spec#33-mediatype-and-file-extensions
        res.set('Content-Type', 'application/x-ndjson');
        // Force a download
        res.set('Content-Disposition', `attachment;filename=gitter-${key}-${dateString}.ndjson`);

        const { cursor, strategy } = await Promise.props({
          cursor: getCursor(req),
          strategy: getStrategy(req)
        });

        let isRequestCanceled = false;
        req.on('close', function() {
          isRequestCanceled = true;
        });

        return await cursor.eachAsync(async item => {
          // Someone may have canceled their download
          // Throw an error to stop iterating in `cursor.eachAsync`
          if (isRequestCanceled) {
            const requestClosedError = new Error('User closed request');
            requestClosedError.requestClosed = true;
            return Promise.reject(requestClosedError);
          }

          const serializedItem = await restSerializer.serializeObject(item, strategy);

          res.write(`${JSON.stringify(serializedItem)}\n`);
        });
      } catch (err) {
        // Someone canceled the download in the middle of downloading
        if (err.requestClosed) {
          // noop otherwise `express-error-handler` will catch it and Express will complain about "Cannot set headers after they are sent to the client"
          return;
        }
        // Only create a new error if it isn't aleady a StatusError
        else if (!(err instanceof StatusError)) {
          throw new StatusError(500, err);
        }

        throw err;
      }
    })
  };
}

module.exports = generateExportResource;