#!/usr/bin/env node
'use strict';

const debug = require('debug')('gitter:app:chat-search-service');
const shutdown = require('shutdown');
const util = require('util');
const request = util.promisify(require('request'));
const env = require('gitter-web-env');
const config = env.config;
const logger = env.logger;
const userService = require('gitter-web-users');
const userSettingsService = require('gitter-web-user-settings');
const downloadFileToBuffer = require('gitter-web-matrix-bridge/lib/download-file-to-buffer');
const obfuscateToken = require('gitter-web-github').obfuscateToken;

require('../../server/event-listeners').install();

const zendeskToken = config.get('zendesk:apiKey');
const zendeskEmail = config.get('zendesk:email');
// https://developer.zendesk.com/api-reference/ticketing/introduction/#api-token
const authorizationString = `${zendeskEmail}/token:${zendeskToken}`;
const authorizationStringBase64 = Buffer.from(authorizationString).toString('base64');
debug('Zendesk authorizationStringBase64', obfuscateToken(authorizationStringBase64));
const authorizationHeader = `Basic ${authorizationStringBase64}`;

const opts = require('yargs')
  .option('dryRun', {
    type: 'boolean',
    description: `If we're doing a dry-run, we won't actually unsubscribe anyone`
  })
  .help('help')
  .alias('help', 'h').argv;

if (opts.dryRun) {
  logger.info('Running as a dry-run!');
}

const AUTOMATED_MESSAGE_NOTICE = `**Note:**${
  opts.dryRun ? ' This is a dry-run!' : ''
} This is an automated message from the [scripts/utils/unsubscribe-spam-complaints.js](https://gitlab.com/gitterHQ/webapp/-/blob/develop/scripts/utils/unsubscribe-spam-complaints.js) utility script (probably ran as a cron).`;

async function unsubscribeUserId(userId) {
  return await userSettingsService.setUserSettings(userId, 'unread_notifications_optout', 1);
}

async function unsubscribeEmail(email) {
  const users = await userService.findAllByEmail(email);

  if (users.length === 0) {
    logger.warn(`Unable to find any Gitter users associated with email=${email}`);
    return [];
  }

  for await (let user of users) {
    const userId = user.id || user._id;

    if (!opts.dryRun) {
      await unsubscribeUserId(userId);
    }
    logger.info(
      `Successfully unsubscribed userId=${userId} username=${user.username} email=${email}`
    );
  }

  return users;
}

async function addCommentToTicket(ticketId, message, status) {
  let endStatus = status;
  // We should not modify the status of the ticket on dry-runs
  if (opts.dryRun) {
    endStatus = undefined;
  }

  const addCommentRes = await request({
    method: 'PUT',
    uri: `https://gitter.zendesk.com/api/v2/tickets/${ticketId}`,
    json: true,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorizationHeader
    },
    body: {
      ticket: {
        comment: {
          body: message,
          public: false
        },
        status: endStatus
      }
    }
  });

  if (addCommentRes.statusCode !== 200) {
    throw new Error(
      `addCommentToTicket failed ticketId=${ticketId}, statusCode=${
        addCommentRes.statusCode
      }, body=${JSON.stringify(addCommentRes.body)}`
    );
  }
}

async function updateTicketWithUnsubscribedUsers(ticketId, email, unsubscribedUsers) {
  let message;
  let status;
  if (unsubscribedUsers.length > 0) {
    status = 'solved';
    // Successfully unsubscribed some users
    message = `${AUTOMATED_MESSAGE_NOTICE}

We've unsubscribed ${unsubscribedUsers
      .map(unsubscribedUser => {
        const userId = unsubscribedUser.id || unsubscribedUser._id;
        return `${unsubscribedUser.username} (${userId})`;
      })
      .join(', ')} based the this spam complaint from ${email}.
    `;
  } else {
    message = `${AUTOMATED_MESSAGE_NOTICE}

Unable to find any Gitter users associated with ${email}. You probably just want to close this ticket but we've left it open for you to review.
    `;
  }

  await addCommentToTicket(ticketId, message, status);
}

async function fetchSpamComplaintTicketIds() {
  let pageCount = 0;

  // Recursive pagination function
  async function _paginateTickets(url) {
    const ticketSearchRes = await request({
      method: 'GET',
      uri: url,
      json: true,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorizationHeader
      }
    });

    if (ticketSearchRes.statusCode !== 200) {
      throw new Error(
        `fetchSpamComplaintTicketIds failed to fetch tickets, pageCount=${pageCount} statusCode=${
          ticketSearchRes.statusCode
        }, body=${JSON.stringify(ticketSearchRes.body)}`
      );
    }

    const ticketIds = ticketSearchRes.body.results.map(searchResult => {
      return searchResult.id;
    });

    if (ticketSearchRes.body.next_page) {
      pageCount += 1;
      return ticketIds.concat(_paginateTickets(ticketSearchRes.body.next_page));
    }

    return ticketIds;
  }

  // https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/
  const query = `type:ticket status:open requester:complaints@email-abuse.amazonses.com`;
  const url = `https://gitter.zendesk.com/api/v2/search.json?query=${encodeURIComponent(
    query
  )}&sort_by=created_atstatus&sort_order=desc`;

  return await _paginateTickets(url);
}

async function processSpamComplaints() {
  logger.info('Fetching spam complaint tickets');
  const spamComplaintTicketIds = await fetchSpamComplaintTicketIds();
  logger.info('spamComplaintTicketIds:', spamComplaintTicketIds.join(', '));

  for await (let ticketId of spamComplaintTicketIds) {
    try {
      const ticketCommentGetRes = await request({
        method: 'GET',
        uri: `https://gitter.zendesk.com/api/v2/tickets/${ticketId}/comments`,
        json: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorizationHeader
        }
      });

      if (ticketCommentGetRes.statusCode !== 200) {
        throw new Error(
          `Failed to fetch comments for ticket, ticketId=${ticketId} statusCode=${
            ticketCommentGetRes.statusCode
          }, body=${JSON.stringify(ticketCommentGetRes.body)}`
        );
      }

      const attachments = ticketCommentGetRes.body.comments[0].attachments;

      if (attachments.length > 0) {
        const emailAttachments = attachments.filter(attachment => {
          return attachment.file_name.endsWith('.eml');
        });

        if (emailAttachments.length !== 1) {
          throw new Error(
            `Expected 1 .eml attachment for ticketId=${ticketId} but received ${emailAttachments.length} emailAttachments=${emailAttachments}`
          );
        }

        const emailAttachment = emailAttachments[0];

        const data = await downloadFileToBuffer(emailAttachment.content_url);
        const emailMatches = String(data.buffer).match(/^To: (.*?)$/m);

        if (emailMatches) {
          const email = emailMatches[1];
          const unsubscribedUsers = await unsubscribeEmail(email);
          await updateTicketWithUnsubscribedUsers(ticketId, email, unsubscribedUsers);
        } else {
          throw new Error(
            `Unable to find the To: field in the .eml attachment for ticketId=${ticketId}`
          );
        }
      }
    } catch (err) {
      // Log the error and move on to the next ticket
      const errorMessage = `Failed to process ticketId=${ticketId}: ${err}\n${err.stack}`;
      logger.error(errorMessage);
      await addCommentToTicket(ticketId, `${AUTOMATED_MESSAGE_NOTICE}\n\n${errorMessage}`);
    }
  }
}

(async () => {
  try {
    await processSpamComplaints();
    logger.info(`Done handling spam complaints`);

    // wait 5 seconds to allow for asynchronous `event-listeners` to finish
    // This isn't clean but works
    // https://github.com/troupe/gitter-webapp/issues/580#issuecomment-147445395
    // https://gitlab.com/gitterHQ/webapp/merge_requests/1605#note_222861592
    logger.info(`Waiting 5 seconds to allow for the asynchronous \`event-listeners\` to finish...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  } catch (err) {
    logger.info('Error', err, err.stack);
  } finally {
    shutdown.shutdownGracefully();
  }
})();
