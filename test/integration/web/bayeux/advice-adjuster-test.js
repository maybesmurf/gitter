"use strict";

var testRequire = require('../../test-require');
var assert = require('assert');
var _ = require('underscore');
var mockConfig = require('../../mock-config');

describe("advice-adjuster", function() {
  var adviceAdjuster;

  beforeEach(function() {
    var config = mockConfig({
      ws: {
        fayeTimeout: 45,
        fayeInterval: 1,
        subscribeTimeoutThreshold: 5000
      }
    });

    var env = {
      config: config
    };

    var AdviceAdjuster = testRequire.withProxies('./web/bayeux/advice-adjuster', {
      '../../utils/env': env
    });

    adviceAdjuster = new AdviceAdjuster();
  });

  it("should handle no data", function() {
    assert.strictEqual(adviceAdjuster.getFayeTimeout(), 45);
    assert.strictEqual(adviceAdjuster.getFayeInterval(), 1);
  });

  [
    { avg: 30, timeout: 45, interval: 1 },
    { avg: 5000, timeout: 45, interval: 1 },
    { avg: 10000, timeout: 53, interval: 3 },
    { avg: 40000, timeout: 101, interval: 15 },
    { avg: 80000, timeout: 165, interval: 31 },
    { avg: 160000, timeout: 293, interval: 63 },
  ].forEach(function(item) {

      it("should handle average of " + item.avg, function() {
        _.range(30).forEach(function() {
          adviceAdjuster._pushProcessingTime(item.avg);
        });

        assert.strictEqual(adviceAdjuster.getFayeTimeout(), item.timeout);
        assert.strictEqual(adviceAdjuster.getFayeInterval(), item.interval);
      });
  });

});
