'use strict';

const path = require('path');
const fs = require('fs-extra');
const { Bridge, Logging, AppServiceRegistration } = require('matrix-appservice-bridge');
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger.get('matrix-bridge');
const stats = env.stats;
const errorReporter = env.errorReporter;

const MatrixEventHandler = require('./matrix-event-handler');

Logging.configure({ level: 'warn' });

const homeserverUrl = config.get('matrix:bridge:homeserverUrl');
const serverName = config.get('matrix:bridge:serverName');
const bridgeUrl = config.get('matrix:bridge:applicationServiceUrl');
const bridgeId = config.get('matrix:bridge:id');
const hsToken = config.get('matrix:bridge:hsToken');
const asToken = config.get('matrix:bridge:asToken');
// The bridge user we are using to interact with everything on the Matrix side
const matrixBridgeMxidLocalpart = config.get('matrix:bridge:matrixBridgeMxidLocalpart');

const registrationConfig = AppServiceRegistration.fromObject({
  id: bridgeId,
  hs_token: hsToken,
  as_token: asToken,
  namespaces: {
    users: [
      {
        exclusive: true,
        // Reserve these MXID's (usernames)
        regex: `@.*-[0-9a-f]+:${serverName}`
      }
    ],
    aliases: [
      {
        exclusive: true,
        // Reserve these room aliases
        regex: `#.*:${serverName}`
      }
    ],
    rooms: [
      {
        exclusive: true,
        // This regex is used to define which rooms we listen to with the bridge.
        // This does not reserve the rooms like the other namespaces.
        regex: '.*'
      }
    ]
  },
  url: bridgeUrl,
  sender_localpart: matrixBridgeMxidLocalpart,
  rate_limited: false,
  protocols: null
});

(async () => {
  // Save this out to a file for local dev Docker usage
  if (process.env.NODE_ENV === 'dev') {
    const savePath = path.join(__dirname, '../../../scripts/docker/matrix/synapse/data/');

    await fs.mkdirp(savePath);
    await registrationConfig.outputAsYaml(
      path.join(savePath, 'gitter-matrix-as-registration.yaml')
    );
  }
})();

let eventHandler;

const matrixBridge = new Bridge({
  homeserverUrl: homeserverUrl,
  domain: serverName,
  registration: registrationConfig,
  disableStores: true,
  controller: {
    onAliasQuery: (alias, matrixRoomId) => {
      return eventHandler.onAliasQuery(alias, matrixRoomId);
    },
    onEvent: async (request /*, context*/) => {
      stats.eventHF('matrix_bridge.event_received');

      let data;
      try {
        data = request.getData();
        await eventHandler.onEventData(data);
        stats.eventHF('matrix-bridge.event.success');
      } catch (err) {
        logger.error(
          `Error while processing Matrix bridge event=(${data && data.event_id}): ${err}`,
          {
            exception: err,
            event: data
          }
        );
        stats.eventHF('matrix-bridge.event.fail');
        errorReporter(
          err,
          { operation: 'matrixBridge.onEvent', data },
          { module: 'matrix-to-gitter-bridge' }
        );
      }

      return null;
    },
    onLog: async (line, isError) => {
      if (isError) {
        logger.error(line);
      } else {
        logger.info(line);
      }
    }
  }
});

eventHandler = new MatrixEventHandler(matrixBridge);

module.exports = matrixBridge;
