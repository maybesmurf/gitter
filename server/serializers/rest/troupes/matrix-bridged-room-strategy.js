'use strict';

const matrixStore = require('gitter-web-matrix-bridge/lib/store');

function MatrixBridgedRoomStrategy() {
  let bridgeMap = {};

  this.preload = async function(troupeIds) {
    for (const troupeId of troupeIds.toArray()) {
      bridgeMap[troupeId] = await matrixStore.getMatrixRoomIdByGitterRoomId(troupeId);
    }
  };

  this.map = function(troupeId) {
    return bridgeMap[troupeId];
  };
}
MatrixBridgedRoomStrategy.prototype = {
  name: 'MatrixBridgedRoomStrategy'
};

module.exports = MatrixBridgedRoomStrategy;
