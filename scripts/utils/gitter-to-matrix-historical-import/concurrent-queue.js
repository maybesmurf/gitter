'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const debugConcurrentQueue = require('debug')('gitter:scripts-debug:concurrent-queue');
const LRU = require('lru-cache');

const env = require('gitter-web-env');
const logger = env.logger;

class ConcurrentQueue {
  constructor(opts = {}) {
    const { concurrency, itemIdGetterFromItem } = opts;
    assert(concurrency);
    this.concurrency = concurrency;
    assert(itemIdGetterFromItem);
    this.itemIdGetterFromItem = itemIdGetterFromItem;

    // Bootstrap the lane status info
    this._laneStatusInfo = {
      lanes: {}
    };
    for (let laneIndex = 0; laneIndex < this.concurrency; laneIndex++) {
      this._laneStatusInfo.lanes[laneIndex] = {};
    }

    // Since this process is meant to be very long-running, prevent it from growing forever
    // as we only need to keep track of the rooms currently being processed. We double it
    // just to account for a tiny bit of overlap while things are transitioning.
    this.itemKeyToLaneIndexCache = LRU({
      max: 2 * this.concurrency
    });

    this._failedItemIds = [];
  }

  async processFromGenerator(itemGenerator, asyncProcesssorTask) {
    assert(itemGenerator);
    assert(asyncProcesssorTask);

    // There will be N lanes to process things in
    const lanes = Array.from(Array(this.concurrency));

    const laneDonePromises = lanes.map(async (_, laneIndex) => {
      let isGeneratorDone = false;
      while (
        !isGeneratorDone &&
        // An escape hatch in case our generator is doing something unexpected. For example, we should
        // never see null/undefined here. Maybe we forgot to await the next item;
        typeof isGeneratorDone === 'boolean'
      ) {
        const nextItem = await itemGenerator.next();
        const { value: itemValue, done } = nextItem;
        isGeneratorDone = done;
        if (typeof isGeneratorDone !== 'boolean') {
          debugConcurrentQueue(
            `concurrentQueue: laneIndex=${laneIndex} encountered a bad item where done=${done}, nextItem=${nextItem}`
          );
        }

        if (itemValue) {
          debugConcurrentQueue(
            `concurrentQueue: laneIndex=${laneIndex} picking up itemValue=${itemValue} (${JSON.stringify(
              itemValue
            )})`
          );

          // Add an easy way to make a lookup from item ID to laneIndex
          const itemId = this.itemIdGetterFromItem(itemValue);
          this.itemKeyToLaneIndexCache.set(itemId, laneIndex);

          // Do the processing
          try {
            await asyncProcesssorTask({ value: itemValue, laneIndex });
          } catch (err) {
            // Log that we failed to process something
            logger.error(`concurrentQueue: Failed to process itemId=${itemId}`, {
              exception: err
            });
            this._failedItemIds.push(itemId);
          }
        }

        if (done) {
          debugConcurrentQueue(`concurrentQueue: laneIndex=${laneIndex} is done`);
        }
      }
    });

    // Wait for all of the lanes to finish
    await Promise.all(laneDonePromises);
  }

  findLaneIndexFromItemId(itemId) {
    return this.itemKeyToLaneIndexCache.get(itemId);
  }

  getLaneStatus(laneIndex) {
    return this._laneStatusInfo.lanes[laneIndex];
  }

  updateLaneStatus(laneIndex, laneStatusInfo) {
    this._laneStatusInfo.lanes[laneIndex] = laneStatusInfo;
  }

  continuallyPersistLaneStatusInfoToDisk(laneStatusFilePath) {
    assert(laneStatusFilePath);

    let writingStatusInfoLock;
    const writeStatusInfo = async () => {
      // Prevent multiple writes from building up. We only allow one write every 0.5
      // seconds until it finishes
      if (writingStatusInfoLock) {
        return;
      }

      writingStatusInfoLock = true;
      try {
        this._laneStatusInfo.writeTime = Date.now();
        await fs.writeFile(laneStatusFilePath, JSON.stringify(this._laneStatusInfo));
      } catch (err) {
        logger.error(`Problem persisting lane status to disk`, { exception: err });
      } finally {
        writingStatusInfoLock = false;
      }
    };

    // Write every 0.5 seconds
    const writeStatusInfoIntervalId = setInterval(writeStatusInfo, 500);
    this._writeStatusInfoIntervalId = writeStatusInfoIntervalId;
  }

  stopPersistLaneStatusInfoToDisk() {
    if (this._writeStatusInfoIntervalId) {
      clearInterval(this._writeStatusInfoIntervalId);
    }
  }

  getFailedItemIds() {
    return this._failedItemIds;
  }
}

module.exports = ConcurrentQueue;
