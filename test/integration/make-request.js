'use strict';

const useragent = require('useragent');

function makeRequest(userAgent) {
  return {
    headers: {
      'user-agent': userAgent
    },
    getParsedUserAgent: function() {
      return useragent.parse(userAgent);
    }
  };
}

module.exports = makeRequest;
