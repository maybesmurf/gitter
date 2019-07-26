'use strict';

const assert = require('assert');
const urlJoin = require('url-join');

const generateFixtures = require('./support/generate-fixtures');

const gitterBaseUrl = Cypress.env('baseUrl');
assert(gitterBaseUrl);

describe('e2e tests', function() {
  before(() => {
    cy.toggleFeature('vue-left-menu', true);
  });

  beforeEach(() => {
    // Remember the feature toggle cookie
    Cypress.Cookies.preserveOnce('fflip');
  });

  it('loads homepage', function() {
    cy.visit(gitterBaseUrl);

    cy.contains('Where communities thrive');
  });

  describe('signed in', () => {
    let fixtures;
    beforeEach(() => {
      return generateFixtures({
        user1: {
          accessToken: 'web-internal'
        },
        group1: {
          securityDescriptor: {
            extraAdmins: ['user1']
          }
        },
        troupe1: { users: ['user1'] },
        troupeInGroup1: { group: 'group1', users: ['user1'] }
      }).then(newFixtures => {
        fixtures = newFixtures;
      });
    });

    beforeEach(() => {
      cy.login(fixtures.user1);
    });

    it('shows chat page', function() {
      cy.visit(urlJoin(gitterBaseUrl, fixtures.troupe1.lcUri));

      // Ensure the left-menu is loaded
      cy.get('.js-left-menu-root').contains(/All conversations/i);
      cy.get('.js-left-menu-root').contains(fixtures.troupe1.uri);

      // Ensure the room is loaded
      cy.get('.js-chat-name').contains(fixtures.troupe1.uri);
    });

    it('can send message', function() {
      cy.visit(urlJoin(gitterBaseUrl, fixtures.troupe1.lcUri));

      const MESSAGE_CONTENT = 'my new message';

      // Send a message
      cy.get('#chat-input-textarea').type(`${MESSAGE_CONTENT}{enter}`);
      cy.get('#chat-container').contains(MESSAGE_CONTENT);

      // Ensure the message is persisted after reload
      cy.reload();
      cy.get('#chat-container').contains(MESSAGE_CONTENT);
    });

    it('can receive a message', function() {
      cy.visit(urlJoin(gitterBaseUrl, fixtures.troupe1.lcUri));

      const MESSAGE_CONTENT = 'my new message';

      // Make sure our new message does not exist yet
      cy.get('#chat-container')
        .contains(MESSAGE_CONTENT)
        .should('not.exist');

      // Send the message
      cy.request({
        url: urlJoin(gitterBaseUrl, '/api/v1/rooms/', fixtures.troupe1._id, '/chatMessages'),
        method: 'POST',
        body: { text: MESSAGE_CONTENT },
        headers: {
          Authorization: `Bearer ${fixtures.user1.accessToken}`,
          'Content-Type': 'application/json'
        }
      }).then(res => {
        assert.equal(res.status, 200);
      });

      // See the message show up
      cy.get('#chat-container').contains(MESSAGE_CONTENT);
    });

    it('can create a room', function() {
      cy.visit(urlJoin(gitterBaseUrl, fixtures.troupeInGroup1.lcUri));

      const NEW_ROOM_NAME = 'my-new-room';

      // Open the create room flow
      cy.get('.js-left-menu-root .item-create').click();
      cy.get('.js-chat-action-create-room').click();

      // Enter the room name
      cy.get('#create-room-name-input').type(NEW_ROOM_NAME);

      // Click the create submit button
      cy.get('.modal button')
        .contains('Create')
        .click();

      // Modal should go away
      cy.get('.modal').should('not.exist');

      // Ensure the new room is loaded
      cy.get('.welcome-modal__header').contains('Get Started: Spread the word');
      cy.get('.js-chat-name').contains(NEW_ROOM_NAME);
    });
  });
});