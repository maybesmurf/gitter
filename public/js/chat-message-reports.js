'use strict';

const $ = require('jquery');
const _ = require('lodash');
const Backbone = require('backbone');
const Marionette = require('backbone.marionette');
require('./views/behaviors/isomorphic');
const debug = require('debug-proxy')('app:chat-messsage-reports');
const generatePermalink = require('gitter-web-shared/chat/generate-permalink');

const context = require('gitter-web-client-context');

function getAccountAgeString(user) {
  if (user) {
    const createdDate = new Date(user.accountCreatedDate);

    return `
      ${Math.floor(
        (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)
      )} days, ${createdDate.getFullYear()}-${createdDate.getMonth()}-${createdDate.getDay()}
    `;
  }

  return '';
}

const ReportView = Marionette.ItemView.extend({
  tagName: 'tr',

  template: data => {
    return `
      <td class="admin-chat-report-table-cell admin-chat-report-table-reporter-cell model-id-${_.escape(
        data.reporterUser && data.reporterUser.id
      )}">
        <div class="admin-chat-report-table-reporter-cell-username">
          ${_.escape(data.reporterUser ? data.reporterUser.username : 'Unknown')}
        </div>
        <div class="admin-chat-report-table-reporter-cell-id">
          ${_.escape(data.reporterUserId)}
        </div>
        <div title="Account age">
          ${_.escape(getAccountAgeString(data.reporterUser))}
        </div>
      </td>
      <td class="admin-chat-report-table-cell admin-chat-report-table-message-author-cell model-id-${_.escape(
        data.messageUser && data.messageUser.id
      )}">
        <div class="admin-chat-report-table-message-author-cell-username">
          ${_.escape(data.messageUser ? data.messageUser.username : 'Unknown')}
        </div>
        <div class="admin-chat-report-table-message-author-cell-id">
          ${_.escape(data.messageUserId)}
        </div>
        <div title="Account age">
          ${_.escape(getAccountAgeString(data.messageUser))}
        </div>
      </td>

      <td class="admin-chat-report-table-cell admin-chat-report-item-message-text">
        <div>
          Weight: <strong>${_.escape(data.weight)}</strong>&nbsp;&nbsp;&nbsp;--&nbsp;${_.escape(
      data.sent
    )}
        </div>
        <div class="admin-chat-report-table-message-cell-id">
          ${_.escape(data.messageId)}
        </div>
        <div>
          ${_.escape(data.messageText)}
        </div>
      </td>

      <td class="admin-chat-report-table-cell admin-chat-report-table-room-cell">
      <div class="admin-chat-report-table-room-cell-uri">
          ${_.escape(data.message && data.message.toTroupe && data.message.toTroupe.uri)}
          <a class="admin-chat-report-table-room-cell-link" href="${_.escape(
            data.message &&
              data.message.toTroupe &&
              generatePermalink(data.message.toTroupe.uri, data.message.id)
          )}" target="_blank">
            <svg viewbox="0 128 768 768" xmlns="http://www.w3.org/2000/svg">
              <path d="M640 768H128V257.90599999999995L256 256V128H0v768h768V576H640V768zM384 128l128 128L320 448l128 128 192-192 128 128V128H384z"/>
            </svg>
          </a>
        </div>
        <div class="admin-chat-report-table-room-cell-id">
          ${_.escape(data.message && data.message.toTroupe && data.message.toTroupe.id)}
        </div>
      </td>
    `;
  }
});

const ReportCollectionView = Marionette.CompositeView.extend({
  childView: ReportView,
  childViewContainer: '.js-report-list',

  childViewOptions: function(item) {
    return item;
  },

  template: function() {
    return `
      <table>
        <thead>
          <tr>
            <td class="admin-chat-report-table-header-cell admin-chat-report-table-reporter-cell">
              Reporter
            </td>
            <td class="admin-chat-report-table-header-cell admin-chat-report-table-message-author-cell">
              Message Author
            </td>
            <td class="admin-chat-report-table-header-cell">
              Message text
            </td>
            <td class="admin-chat-report-table-header-cell">
              Room
            </td>
          </tr>
        </thead>
        <tbody class="js-report-list"></tbody>
      </table>
    `;
  }
});

const DashboardView = Marionette.LayoutView.extend({
  behaviors: {
    Isomorphic: {
      reportTable: { el: '.js-report-table', init: 'initReportCollectionView' }
    }
  },

  initReportCollectionView: function(optionsForRegion) {
    return new ReportCollectionView(
      optionsForRegion({
        collection: new Backbone.Collection(this.model.get('reports'))
      })
    );
  },

  template: function(data) {
    const reports = data.reports;
    const lastReport = reports && reports[reports.length - 1];

    let paginationLink = '';
    if (lastReport) {
      paginationLink = `
        <hr />
        <a href="?beforeId=${lastReport.id}">
          Next page
        </a>
      `;
    }

    return `
      <div class="dashboard">
        <div class="js-report-table"></div>

        ${paginationLink}
        <br />
        <br />
        <br />
        <br />
      </div>
    `;
  }
});

const snapshot = context.getSnapshot('adminChatMessageReportDashboard');

debug('snapshot', snapshot);

new DashboardView({
  el: $('.js-chat-message-report-dashboard-root'),
  model: new Backbone.Model(snapshot)
}).render();
