'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const debug = require('debug')('gitter:scripts-debug:concurrent-queue');
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
      writeTs: null,
      startTs: null,
      finishTs: null,
      // User-defined fields
      overallAttributes: {},
      // User-defined fields for each lane
      lanes: {
        // 0: { ... }
        // 1: { ... }
      }
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

  async processFromGenerator(itemGenerator, filterItemFunc, asyncProcesssorTask) {
    assert(itemGenerator);
    assert(asyncProcesssorTask);

    // Mark when we started
    this._laneStatusInfo.startTs = Date.now();

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
          debug(
            `concurrentQueue: laneIndex=${laneIndex} encountered a bad item where done=${done}, nextItem=${nextItem}.\n` +
              `If you're seeing this error, this probably means that we're not returning a promise from the generator (check that it's an async generator)`
          );
        }

        if (itemValue) {
          debug(
            `concurrentQueue: laneIndex=${laneIndex} picking up itemValue=${itemValue} (${JSON.stringify(
              itemValue
            )})`
          );

          const itemId = this.itemIdGetterFromItem(itemValue);
          // Filter out items first
          if (filterItemFunc(itemValue)) {
            // Add an easy way to make a lookup from item ID to laneIndex
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
          } else {
            debug(`concurrentQueue: laneIndex=${laneIndex} filtered out itemId=${itemId}`);
          }
        }

        if (done) {
          debug(`concurrentQueue: laneIndex=${laneIndex} is done`);
        }
      }
    });

    // Wait for all of the lanes to finish
    await Promise.all(laneDonePromises);

    // Mark when we finished
    this._laneStatusInfo.finishTs = Date.now();
  }

  findLaneIndexFromItemId(itemId) {
    return this.itemKeyToLaneIndexCache.get(itemId);
  }

  getLaneStatus(laneIndex) {
    return this._laneStatusInfo.lanes[laneIndex];
  }

  updateLaneStatus(laneIndex, newLaneStatusInfo) {
    this._laneStatusInfo.lanes[laneIndex] = {
      ...this._laneStatusInfo.lanes[laneIndex],
      ...newLaneStatusInfo
    };
  }

  getLaneStatusOverallAttributes() {
    return this._laneStatusInfo.overallAttributes;
  }

  updateLaneStatusOverallAttributes(newOverallAttributes) {
    this._laneStatusInfo.overallAttributes = {
      ...this._laneStatusInfo.overallAttributes,
      ...newOverallAttributes
    };
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
        this._laneStatusInfo.writeTs = Date.now();
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
