'use strict';

const fs = require('fs').promises;
const assert = require('assert');

const env = require('gitter-web-env');
const logger = env.logger;
const mongoUtils = require('gitter-web-persistence-utils/lib/mongo-utils');

// Loop through all of the lanes and find the oldest room ID
function getGitterRoomIdResumePositionFromConcurrentQueue(concurrentQueue) {
  // Get a list of room ID's that the queue is currently working on
  const roomIds = [];
  for (let i = 0; i < concurrentQueue.concurrency; i++) {
    const laneStatusInfo = concurrentQueue.getLaneStatus(i);
    const laneWorkingOnGitterRoomId =
      laneStatusInfo.gitterRoom && (laneStatusInfo.gitterRoom.id || laneStatusInfo.gitterRoom._id);
    if (laneWorkingOnGitterRoomId) {
      roomIds.push(laneWorkingOnGitterRoomId);
    }
  }

  // Sort the list so the oldest room is sorted first
  const chronologicalSortedRoomIds = roomIds.sort((a, b) => {
    const aTimestamp = mongoUtils.getDateFromObjectId(a);
    const bTimestamp = mongoUtils.getDateFromObjectId(b);
    return aTimestamp - bTimestamp;
  });

  // Take the oldest room in the list. We have to be careful and keep this as the oldest
  // room currently being imported. When we resume, we want to make sure we don't skip
  // over a room that has many many messages just because we imported a bunch of small
  // rooms after in other lanes.
  const trackingResumeFromRoomId = chronologicalSortedRoomIds[0];

  return trackingResumeFromRoomId;
}

async function getRoomIdResumePositionFromFile(roomResumePositionCheckpointFilePath) {
  try {
    logger.info(
      `Trying to read resume information from roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`
    );
    const fileContents = await fs.readFile(roomResumePositionCheckpointFilePath);
    const checkpointData = JSON.parse(fileContents);
    return checkpointData.resumeFromRoomId;
  } catch (err) {
    logger.error(
      `Unable to read roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`,
      {
        exception: err
      }
    );
  }
}

function occasionallyPersistRoomResumePositionCheckpointFileToDisk({
  concurrentQueue,
  roomResumePositionCheckpointFilePath,
  persistToDiskIntervalMs
}) {
  assert(concurrentQueue);
  assert(roomResumePositionCheckpointFilePath);
  assert(persistToDiskIntervalMs);

  let writingCheckpointFileLock;
  const calculateWhichRoomToResumeFromIntervalId = setInterval(async () => {
    const trackingResumeFromRoomId = getGitterRoomIdResumePositionFromConcurrentQueue(
      concurrentQueue
    );

    // Nothing to resume at yet, skip
    if (!trackingResumeFromRoomId) {
      return;
    }

    // Prevent multiple writes from building up. We only allow one write until it finishes
    if (writingCheckpointFileLock) {
      return;
    }

    const checkpointData = {
      resumeFromRoomId: trackingResumeFromRoomId
    };

    try {
      logger.info(
        `Writing room checkpoint file to disk roomResumePositionCheckpointFilePath=${roomResumePositionCheckpointFilePath}`,
        checkpointData
      );
      writingCheckpointFileLock = true;
      await fs.writeFile(roomResumePositionCheckpointFilePath, JSON.stringify(checkpointData));
    } catch (err) {
      logger.error(`Problem persisting room checkpoint file to disk`, { exception: err });
    } finally {
      writingCheckpointFileLock = false;
    }
  }, persistToDiskIntervalMs);

  return calculateWhichRoomToResumeFromIntervalId;
}

module.exports = {
  getRoomIdResumePositionFromFile,
  occasionallyPersistRoomResumePositionCheckpointFileToDisk,

  getGitterRoomIdResumePositionFromConcurrentQueue
};
