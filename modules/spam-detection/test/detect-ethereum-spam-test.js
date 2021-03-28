'use strict';

const assert = require('assert');
const fixtureLoader = require('gitter-web-test-utils/lib/test-fixtures');

const identityService = require('gitter-web-identity');
const detectEthereumSpam = require('../lib/detect-ethereum-spam');

const MESSAGE_FIXTURE_MAP = {
  'Send 3ETH 0x31999626cDc00c877530b64c209707Ad0ED556fE': true,
  'sent 5 ETH 0x519040d1Daa5Ab78b9C87F825A38b5464Cd3828d': true,
  'I tried to send 5 ETHER from my wallet, transaction will be created but will not confirm': false,
  'After doing "migrate", I got my ETH token address 0xfb88de099e13c3ed21f80a7a1e49f8caecf10df6': false,
  'Beth experienced a BSOD at memory address 0x31999626cDc00c877530b64c209707Ad0ED556fE': false
};

describe('detect-ethereum-spam', () => {
  const fixture = fixtureLoader.setup({
    deleteDocuments: {
      User: [{ username: '_fake_test_twitter' }, { username: '_fake_test_gitlab' }],
      Identity: [
        {
          provider: identityService.TWITTER_IDENTITY_PROVIDER,
          providerKey: '_fake_test_twitter'
        },
        {
          provider: identityService.GITLAB_IDENTITY_PROVIDER,
          providerKey: '_fake_test_gitlab'
        }
      ]
    },
    userTwitter: {
      username: '_fake_test_twitter'
    },
    userGitLab: {
      username: '_fake_test_gitlab'
    },
    identityTwitter: {
      user: 'userTwitter',
      provider: identityService.TWITTER_IDENTITY_PROVIDER,
      providerKey: '_fake_test_twitter'
    },
    identityGitLab: {
      user: 'userGitLab',
      provider: identityService.GITLAB_IDENTITY_PROVIDER,
      providerKey: '_fake_test_gitlab'
    }
  });

  describe('with Twitter user', () => {
    describe('in bad group', () => {
      Object.keys(MESSAGE_FIXTURE_MAP).forEach(text => {
        const expectedIsSpamming = MESSAGE_FIXTURE_MAP[text];

        it(`${expectedIsSpamming}: ${text}`, () => {
          return detectEthereumSpam({
            groupId: 'bad-group',
            groupIdBlackList: ['bad-group'],
            user: fixture.userTwitter,
            text
          }).then(isSpamming => {
            assert.strictEqual(isSpamming, expectedIsSpamming);
          });
        });
      });
    });

    describe('in good group', () => {
      Object.keys(MESSAGE_FIXTURE_MAP).forEach(text => {
        const expectedIsSpamming = false;

        it(`${expectedIsSpamming}: ${text}`, () => {
          return detectEthereumSpam({
            groupId: 'good-group',
            groupIdBlackList: ['bad-group'],
            user: fixture.userTwitter,
            text
          }).then(isSpamming => {
            assert.strictEqual(isSpamming, expectedIsSpamming);
          });
        });
      });
    });
  });

  describe('with GitLab user (always false)', () => {
    Object.keys(MESSAGE_FIXTURE_MAP).forEach(text => {
      const expectedIsSpamming = false;

      it(`${expectedIsSpamming}: ${text}`, () => {
        return detectEthereumSpam({
          groupId: 'bad-group',
          groupIdBlackList: ['bad-group'],
          user: fixture.userGitLab,
          text
        }).then(isSpamming => {
          assert.strictEqual(isSpamming, expectedIsSpamming);
        });
      });
    });
  });
});
