'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const readline = require('readline');
const _ = require('lodash');

const formatDurationInMsToPrettyString = require('./gitter-to-matrix-historical-import/format-duration-in-ms-to-pretty-string');

const laneStatusFilePath = path.resolve(
  __dirname,
  './gitter-to-matrix-historical-import/_lane-worker-status-data.json'
);

let isLaneStatusInfoStale = false;
let laneStatusInfo = {};

function getLaneStatusMessage() {
  const laneStrings = Object.keys(laneStatusInfo.lanes || {}).map(laneIndex => {
    const laneStatus = laneStatusInfo.lanes[laneIndex];

    const laneString = `${String(laneIndex).padStart(2)}`;

    const gitterRoom = laneStatus.gitterRoom;
    const gitterRoomString = `${gitterRoom && gitterRoom.uri} (${gitterRoom && gitterRoom.id})`;

    const progressString = `${String(laneStatus.numMessagesImported).padStart(6)}/${String(
      laneStatus.numTotalMessagesInRoom
    ).padEnd(7)}`;

    const progressDecimal = laneStatus.numMessagesImported / laneStatus.numTotalMessagesInRoom;
    const progressBarWidth = 30;
    const progressBarJuice = '='.repeat(Math.floor(progressBarWidth * progressDecimal));
    const progressBarString = `[${progressBarJuice.padEnd(progressBarWidth)}]`;

    const durationString = `${formatDurationInMsToPrettyString(Date.now() - laneStatus.startTs)}`;

    return `${laneString}: ${progressBarString} ${progressString} ${gitterRoomString} - ${durationString}`;
  });

  const currentTimeString = `Current time: ${new Date().toISOString()}`;
  const laneWriteTimeString = `Lane status write time: ${laneStatusInfo.writeTime &&
    new Date(laneStatusInfo.writeTime).toISOString()} (${laneStatusInfo.writeTime &&
    formatDurationInMsToPrettyString(
      Date.now() - laneStatusInfo.writeTime
    )} old) (last read was error? ${isLaneStatusInfoStale})`;

  return `${currentTimeString}\n${laneWriteTimeString}\n${laneStrings.join('\n')}`;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

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
      isLaneStatusInfoStale = false;
    } catch (err) {
      // Failed to read file or parse but we'll just try again in the next loop.
      // We'll just mark the data as stale for now
      isLaneStatusInfoStale = true;
    }

    throttledUpdateCli();

    // Some delay just to not hit as hard as possible
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }
}

exec();
