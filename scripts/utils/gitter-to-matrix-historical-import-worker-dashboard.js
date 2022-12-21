#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs').promises;
const readline = require('readline');
const _ = require('lodash');

const formatDurationInMsToPrettyString = require('./gitter-to-matrix-historical-import/format-duration-in-ms-to-pretty-string');

const ROLLING_AVERAGE_SAMPLE_WINDOW = 6;

const opts = require('yargs')
  .option('worker-index', {
    type: 'number',
    description:
      '1-based index of the worker. We use this to grab the right file for lane status data'
  })
  .help('help')
  .alias('help', 'h').argv;

let laneStatusFilePath = path.resolve(
  __dirname,
  `./gitter-to-matrix-historical-import/_lane-worker-status-data${opts.workerIndex || ''}.json`
);

let isLaneStatusInfoStale = false;
let previousLaneStatusInfo = {};
let laneStatusInfo = {};

const eventSendRateSamples = [];

function calculateEventSendRateBetweenPrevAndNow(previousLaneStatusInfo, laneStatusInfo) {
  const overallAttributes = laneStatusInfo.overallAttributes || {};
  const previousOverallAttributes = previousLaneStatusInfo.overallAttributes || {};
  const newEventsFromLastTime =
    overallAttributes.eventsImportedRunningTotal -
    previousOverallAttributes.eventsImportedRunningTotal;
  const writeTimeDifferenceMs = laneStatusInfo.writeTs - previousLaneStatusInfo.writeTs;
  const eventSendRate = newEventsFromLastTime / (writeTimeDifferenceMs / 1000);

  return eventSendRate;
}

function getLaneStatusMessage() {
  const laneStrings = Object.keys(laneStatusInfo.lanes || {}).map(laneIndex => {
    const laneStatus = laneStatusInfo.lanes[laneIndex];

    const laneString = `${String(laneIndex).padStart(2)}`;

    if (laneStatus.laneDone) {
      return `${laneString}: No more rooms for this lane to pick-up ✅`;
    }

    const gitterRoom = laneStatus.gitterRoom;
    const gitterRoomString = `${gitterRoom && gitterRoom.uri} (${gitterRoom && gitterRoom.id})`;

    const progressString = `${String(laneStatus.numMessagesImported).padStart(6)}/${String(
      laneStatus.numTotalMessagesInRoom
    ).padEnd(7)}`;

    const progressDecimal = laneStatus.numMessagesImported / laneStatus.numTotalMessagesInRoom;
    const progressBarWidth = 30;
    const progressBarJuice = '='.repeat(Math.floor(progressBarWidth * progressDecimal));
    const progressBarString = `[${progressBarJuice.padEnd(progressBarWidth)}]`;

    const durationString = `${formatDurationInMsToPrettyString(
      laneStatusInfo.writeTs - laneStatus.startTs
    )}`;

    return `${laneString}: ${progressBarString} ${progressString} ${gitterRoomString} - ${durationString}`;
  });

  const currentTimeString = `Current time: ${new Date().toISOString()}`;
  const laneWriteTimeString = `Lane status write time: ${laneStatusInfo.writeTs &&
    new Date(laneStatusInfo.writeTs).toISOString()} (${laneStatusInfo.writeTs &&
    formatDurationInMsToPrettyString(
      Date.now() - laneStatusInfo.writeTs
    )} old) (last read was error? ${isLaneStatusInfoStale})`;
  const startTimeString = `Start time: ${laneStatusInfo.startTs &&
    new Date(laneStatusInfo.startTs).toISOString()}`;
  let finishTimeString = '';
  if (laneStatusInfo.finishTs) {
    finishTimeString = `🎉 Finish time: ${new Date(laneStatusInfo.finishTs).toISOString()}`;
  } else {
    finishTimeString = `Script has been running for ${laneStatusInfo.writeTs &&
      laneStatusInfo.startTs &&
      formatDurationInMsToPrettyString(laneStatusInfo.writeTs - laneStatusInfo.startTs)}`;
  }

  const overallAttributes = laneStatusInfo.overallAttributes || {};
  const eventsImportedString = `~${overallAttributes.eventsImportedRunningTotal} messages imported`;
  // This is a rolling average (simple moving average)
  const eventSendRate =
    eventSendRateSamples.reduce((accumulator, eventSendRateSample) => {
      return accumulator + eventSendRateSample;
    }, 0) / eventSendRateSamples.length;
  const rateString = `Importing messages at ${eventSendRate.toPrecision(2)}hz`;

  const stringPieces = [
    currentTimeString,
    laneWriteTimeString,
    startTimeString,
    finishTimeString,
    eventsImportedString,
    rateString,
    laneStrings.join('\n')
  ];

  return stringPieces.join('\n');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let lastScreenClearTs = 0;
function updateCli() {
  readline.cursorTo(rl, 0, 0);
  // Only clear the screen every 2 seconds to have less blank popping
  if (Date.now() - lastScreenClearTs > 2 * 1000) {
    readline.clearScreenDown(rl);
    lastScreenClearTs = Date.now();
  }
  rl.write(getLaneStatusMessage());
}

const throttledUpdateCli = _.throttle(updateCli, 500);

let sampleCount = 0;
async function exec() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fileContents = await fs.readFile(laneStatusFilePath);
      const newLaneStatusInfo = JSON.parse(fileContents);

      // New data!
      if (laneStatusInfo.writeTs !== newLaneStatusInfo.writeTs) {
        sampleCount++;
        previousLaneStatusInfo = laneStatusInfo;

        // Keep track of the event send rate over the last N samples (rolling average, simple moving average)
        eventSendRateSamples[sampleCount % ROLLING_AVERAGE_SAMPLE_WINDOW] =
          calculateEventSendRateBetweenPrevAndNow(previousLaneStatusInfo, newLaneStatusInfo) || 0;
      }

      laneStatusInfo = newLaneStatusInfo;
      isLaneStatusInfoStale = false;
      throttledUpdateCli();
    } catch (err) {
      // Failed to read file or parse but we'll just try again in the next loop.
      // We'll just mark the data as stale for now
      isLaneStatusInfoStale = true;
    }

    // Some delay just to not hit as hard as possible
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }
}

exec();
