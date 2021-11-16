'use strict';

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const errorReporter = env.errorReporter;
const obfuscateToken = require('gitter-web-github').obfuscateToken;

const matrixBridge = require('./lib/matrix-bridge');
const GitterBridge = require('./lib/gitter-bridge');
const MatrixUtils = require('./lib/matrix-utils');

const bridgePortFromConfig = config.get('matrix:bridge:applicationServicePort');
const hsToken = config.get('matrix:bridge:hsToken');
const asToken = config.get('matrix:bridge:asToken');

// Ensures the bridge bot user is registered and updates its profile info.
async function ensureCorrectMatrixBridgeUserProfile() {
  try {
    const matrixUtils = new MatrixUtils(matrixBridge);
    await matrixUtils.ensureCorrectMatrixBridgeUserProfile();
  } catch (err) {
    logger.error(`Failed to update the bridge user profile`, {
      exception: err
    });
    errorReporter(err, { operation: 'matrixBridge.install' }, { module: 'matrix-bridge-install' });
  }
}

async function install(bridgePort = bridgePortFromConfig) {
  if (!bridgePort || !hsToken || !asToken) {
    logger.error(
      `No (bridgePort=${bridgePort}, hsToken=${obfuscateToken(hsToken)}, asToken=${obfuscateToken(
        asToken
      )}) specified for Matrix bridge so we won't start it up`
    );
    return;
  }

  await matrixBridge.run(bridgePort);
  logger.info(`Matrix bridge listening on port ${bridgePort}`);

  new GitterBridge(matrixBridge);

  // Fire and forget this (no need to hold up the process by awaiting it)
  ensureCorrectMatrixBridgeUserProfile();
}

module.exports = install;
