'use strict';

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const errorReporter = env.errorReporter;
const obfuscateToken = require('gitter-web-github').obfuscateToken;

const matrixBridge = require('./lib/matrix-bridge');
const GitterBridge = require('./lib/gitter-bridge');
const MatrixUtils = require('./lib/matrix-utils');

// Ensures the bridge bot user is registered and updates its profile info.
async function ensureCorrectMatrixBridgeUserProfile(bridgeConfig) {
  try {
    const matrixUtils = new MatrixUtils(matrixBridge, bridgeConfig);
    await matrixUtils.ensureCorrectMatrixBridgeUserProfile();
  } catch (err) {
    logger.error(`Failed to update the bridge user profile`, {
      exception: err
    });
    errorReporter(err, { operation: 'matrixBridge.install' }, { module: 'matrix-bridge-install' });
  }
}

async function install(bridgeConfig = config.get('matrix:bridge')) {
  const bridgePort = bridgeConfig.applicationServicePort;
  const hsToken = bridgeConfig.hsToken;
  const asToken = bridgeConfig.asToken;

  if (!bridgePort || !hsToken || !asToken) {
    logger.info(
      `No (bridgePort=${bridgePort}, hsToken=${obfuscateToken(hsToken)}, asToken=${obfuscateToken(
        asToken
      )}) specified for Matrix bridge so we won't start it up`
    );
    return;
  }

  await matrixBridge.run(
    bridgePort,
    // config is always null, see https://github.com/matrix-org/matrix-appservice-bridge/issues/262
    null
  );
  logger.info(`Matrix bridge listening on port ${bridgePort}`);

  new GitterBridge(matrixBridge, bridgeConfig);

  // Fire and forget this (no need to hold up the process by awaiting it)
  ensureCorrectMatrixBridgeUserProfile(bridgeConfig);
}

module.exports = install;
