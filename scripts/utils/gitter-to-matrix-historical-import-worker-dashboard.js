'use strict';

const path = require('path');
const fs = require('fs').promises;
const readline = require('readline');
const _ = require('lodash');

const laneStatusFilePath = path.resolve(
  __dirname,
  './gitter-to-matrix-historical-import/_lane-worker-status-data.json'
);

let isLaneStatusInfoState = false;
let laneStatusInfo = {};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function getLaneStatusMessage() {
  const laneStrings = Object.keys(laneStatusInfo.lanes || {}).map(laneIndex => {
    const laneStatus = laneStatusInfo.lanes[laneIndex];

    const gitterRoom = laneStatus.gitterRoom;
    const gitterRoomString = `${gitterRoom && gitterRoom.uri} (${gitterRoom && gitterRoom.id})`;

    return `${laneIndex}: ${laneStatus.numMessagesImported}/${laneStatus.numTotalMessagesInRoom} ${gitterRoomString}`;
  });

  const currentTimeString = `Current time: ${new Date().toISOString()}`;
  const laneWriteTimeString = `Lane status write time: ${laneStatusInfo.writeTime &&
    new Date(laneStatusInfo.writeTime).toISOString()} (Stale read? ${isLaneStatusInfoState})`;

  return `${currentTimeString}\n${laneWriteTimeString}\n${laneStrings.join('\n')}`;
}

function updateCli() {
  readline.cursorTo(rl, 0, 0);
  readline.clearScreenDown(rl);
  rl.write(getLaneStatusMessage());
}

const throttledUpdateCli = _.throttle(updateCli, 500);

async function exec() {
  while (true) {
    try {
      const fileContents = await fs.readFile(laneStatusFilePath);
      laneStatusInfo = JSON.parse(fileContents);
      isLaneStatusInfoState = false;
    } catch (err) {
      // Failed to read file or parse but we'll just try again in the next loop.
      // We'll just mark the data as stale for now
      isLaneStatusInfoState = true;
    }

    throttledUpdateCli();

    // Some delay just to not hit as hard as possible
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }
}

exec();
