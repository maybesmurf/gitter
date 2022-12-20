'use strict';

const env = require('gitter-web-env');
const logger = env.logger;
const config = env.config;
const errorReporter = env.errorReporter;
const obfuscateToken = require('gitter-web-github').obfuscateToken;

const matrixBridge = require('./lib/matrix-bridge');
const GitterBridge = require('./lib/gitter-bridge');
const MatrixUtils = require('./lib/matrix-utils');

const bridgePortFromConfig = parseInt(config.get('matrix:bridge:applicationServicePort'), 10);
const hsToken = config.get('matrix:bridge:hsToken');
const asToken = config.get('matrix:bridge:asToken');
// This will only apply in dev scenarios
const skipMatrixBridgeUserProfileSetupConfig = config.get(
  'matrix:bridge:skipMatrixBridgeUserProfileSetup'
);

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

const gitterBridge = new GitterBridge(matrixBridge);

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

  await gitterBridge.start();

  // Only allow skipping over this in development. The reason you would want to skip is
  // to avoid the repetitive avatar upload that creates a lot of log noise every time
  // the app starts up. `matrix__bridge__skipMatrixBridgeUserProfileSetup=1`
  const skipMatrixBridgeUserProfileSetup =
    process.env.NODE_ENV === 'dev' && skipMatrixBridgeUserProfileSetupConfig;
  if (skipMatrixBridgeUserProfileSetup) {
    logger.warn(
      'Skipping matrix bridge user profile setup (this config option only applies in a dev environment)'
    );
  } else {
    // Fire and forget this (no need to hold up the process by awaiting it)
    ensureCorrectMatrixBridgeUserProfile();
  }

  return async function stop() {
    await matrixBridge.close();
    await gitterBridge.stop();
  };
}

module.exports = install;
