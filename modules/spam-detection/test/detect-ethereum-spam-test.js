'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');

const detectEthereumSpam = require('../lib/detect-ethereum-spam');

const MESSAGE_FIXTURE_MAP = {
  '0x352EF597BC9C551497B3686eA3403cA53d105524': true,
  '0xBe0DC5EDC04eFAc1592f212190167fA59A7C5586': true,
  '0x4D8022B0878eDbFA6E3A3dB934DC587eE8053F86': true,
  '0x5a38f4c89a8becaed0d0d03b6d7319f31ebce6c6': true,
  '0x5B47bD0f5E07c590a70CD4D12d709C88845e2f0f': true,
  'Send 3ETH 0x31999626cDc00c877530b64c209707Ad0ED556fE': false,
  'sent 5 ETH 0x519040d1Daa5Ab78b9C87F825A38b5464Cd3828d': false,
  'I tried to send 5 ETHER from my wallet, transaction will be created but will not confirm': false,
  'After doing "migrate", I got my ETH token address 0xfb88de099e13c3ed21f80a7a1e49f8caecf10df6': false,
  'Beth experienced a BSOD at memory address 0x31999626cDc00c877530b64c209707Ad0ED556fE': false
};

describe('detect-ethereum-spam', () => {
  const fixture = fixtureLoader.setup({
    user1: {}
  });

  describe('in a dirty group', () => {
    Object.keys(MESSAGE_FIXTURE_MAP).forEach(text => {
      const expectedIsSpamming = MESSAGE_FIXTURE_MAP[text];

      it(`${expectedIsSpamming}: ${text}`, async () => {
        const isSpamming = await detectEthereumSpam({
          groupId: 'dirty-group',
          dirtyGroupList: ['dirty-group'],
          user: fixture.user1,
          text
        });

        assert.strictEqual(isSpamming, expectedIsSpamming);
      });
    });
  });

  describe('in a "clean" group that we don\'t need to clean', () => {
    Object.keys(MESSAGE_FIXTURE_MAP).forEach(text => {
      const expectedIsSpamming = false;

      it(`${expectedIsSpamming}: ${text}`, async () => {
        const isSpamming = await detectEthereumSpam({
          groupId: 'good-group',
          groupIdBlackList: ['dirty-group'],
          user: fixture.user1,
          text
        });

        assert.strictEqual(isSpamming, expectedIsSpamming);
      });
    });
  });
});
