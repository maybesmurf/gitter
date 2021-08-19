#!/usr/bin/env node
'use strict';

/*
 * Amazon SES (Simple email service) forwards email spam complaints to our Zendesk instance.
 * This script will ingest these tickets and unsubscribe any users associated with
 * the email.
 *
 * This script will:
 *
 *  1. Fetch all Zendesk tickets sent from AWS
 *  1. Process the `.eml` attachment to find who(which email) sent the complaint.
 *     If no attachment is present, will look for the ARF(embedded email abuse format)
 *     format in the ticket comment body.
 *  1. Unsubscribe any Gitter users associated with that email
 *  1. Add a comment to the ticket with what actions took place.
 *  1. If we were able to unsubscribe someone, will solve the ticket
 *  1. If any error took place while processing that specific ticket, will also put that
 *     on the ticket
 */

const assert = require('assert');
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
const unsubscribeHashes = require('gitter-web-email-notifications/lib/unsubscribe-hashes');

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

// This is to make code fences/blocks in Zendesk because ``` is not supported
function indent(inputString) {
  return inputString
    .split('\n')
    .map(line => `\n    ${line}`)
    .join('');
}

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

async function updateTicketWithUnsubscribedUsers(ticketId, unsubscribedUsers) {
  assert(ticketId);
  assert(unsubscribedUsers);
  assert(unsubscribedUsers.length > 0);

  let status = 'solved';
  // Successfully unsubscribed some users
  let message = `${AUTOMATED_MESSAGE_NOTICE}

We've unsubscribed ${unsubscribedUsers
    .map(unsubscribedUser => {
      const userId = unsubscribedUser.id || unsubscribedUser._id;
      return `${unsubscribedUser.username} (${userId})`;
    })
    .join(', ')} based this spam complaint.
  `;

  await addCommentToTicket(ticketId, message, status);
}

async function _getReportedEmailContentsFromCommentAttachments(ticketId, comment) {
  assert(ticketId);
  assert(comment);

  const attachments = comment.attachments;

  const emailAttachments = attachments.filter(attachment => {
    return attachment.file_name.endsWith('.eml');
  });

  // If there are more(or less) than 1 .eml attachment, we might process it wrong
  // because we only expect the reported `.eml` to be present.
  if (emailAttachments.length !== 1) {
    throw new Error(
      `Expected 1 .eml attachment for ticketId=${ticketId} but received ${emailAttachments.length} attachments=${attachments}`
    );
  }

  const emailAttachment = emailAttachments[0];

  const data = await downloadFileToBuffer(emailAttachment.content_url);

  return String(data.buffer);
}

// eslint-disable-next-line
/*
Here is an example of what we are trying to processing.
It's called the Abuse Feedback Reporting Format (ARF)
but really it just seems like the reported .eml we sent in another .eml.

```
To: Gitter Notifications <support@gitter.im>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=feedback-report;
	boundary="feedback_part_610bfbf9_23c25613_42c9adea"
[...]

--feedback_part_610bfbf9_23c25613_42c9adea
Content-Type: text/plain; charset="US-ASCII"
Content-Transfer-Encoding: 7bit

This is an email abuse report for an email message received from IP
XX.XXX.XX.XXX on Thu, 05 Aug 2021 09:10:04 +0800. For more information
about this format please see http://www.mipassoc.org/arf/.

--feedback_part_610bfbf9_23c25613_42c9adea
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: mail.qq.com
[...]
Original-Rcpt-To: <xxx@qq.com>

--feedback_part_610bfbf9_23c25613_42c9adea
Content-Type: message/rfc822
Content-Disposition: inline

Received: from XX.XXX.XX.XXX (unknown [XX.XXX.XX.XXX])
	by newmx32.qq.com (NewMx) with SMTP id
	for <xxx@qq.com>; Thu, 05 Aug 2021 09:10:06 +0800
[...]
Content-Type: multipart/alternative;
boundary="--_NmP-3e1543c0fceea401-Part_1"
From: Gitter Notifications <support@gitter.im>
To: xxx@qq.com

----_NmP-3e1543c0fceea401-Part_1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hi there,

This is what you missed while you were away.
[Text email version...]


----_NmP-3e1543c0fceea401-Part_1
Content-Type: text/html; charset=utf-8
[HTML email version...]

----_NmP-3e1543c0fceea401-Part_1--


--feedback_part_610bfbf9_23c25613_42c9adea--
```
 */
async function _getReportedEmailContentsFromCommentBody(ticketId, comment) {
  assert(ticketId);
  assert(comment);

  // Process the Abuse Feedback Reporting Format (ARF), see the comment above for an example
  const firstBoundaryMatches = comment.body.match(/^\s+boundary="(.*?)"$/m);

  if (!firstBoundaryMatches) {
    throw new Error('Unable to find boundary markers in ARF comment body');
  }

  const boundaryMarker = firstBoundaryMatches[1];
  const boundarySplit = `--${boundaryMarker}`;
  const arfPieces = comment.body.split(boundarySplit);

  if (arfPieces.length <= 1) {
    throw new Error(
      `Expected ARF from comment body to be made up of multiple pieces (most likely 4) but found ${arfPieces.length} pieces split up by \`${boundarySplit}\`.`
    );
  }

  // Find the arf piece which has `Content-Type: message/rfc822` in it.
  // This will be like `.eml` attachment we are used to in `getReportedEmailContentsFromCommentAttachments`
  const eml = arfPieces.find(arfPiece => {
    return arfPiece.match(/^Content-Type: message\/rfc822$/m);
  });

  return eml;
}

async function getReportedEmailContentsFromComment(ticketId, comment) {
  assert(ticketId);
  assert(comment);

  let reportedEmailContents;
  let checkCommentAttachmentsError;
  try {
    // First lets check if the spam complaint has a `.eml` attachment with the reported email in question
    reportedEmailContents = await _getReportedEmailContentsFromCommentAttachments(
      ticketId,
      comment
    );
  } catch (err) {
    checkCommentAttachmentsError = err;
  }

  let checkInlineCommentError;
  if (!reportedEmailContents) {
    try {
      // Fallback to trying to parse the report directly in the comment itself.
      // The ticket comment itself might be a raw ARF format.
      reportedEmailContents = await _getReportedEmailContentsFromCommentBody(ticketId, comment);
    } catch (err) {
      checkInlineCommentError = err;
    }
  }

  if (!reportedEmailContents) {
    throw new Error(`
Unable to get reported email contents from this spam complaint.
We checked the attachments on this ticket but ran into this problem:

${checkCommentAttachmentsError && indent(checkCommentAttachmentsError.stack)}

We also checked the ticket comment itself but weren't able to see or parse an ARF format from it:

${checkInlineCommentError && indent(checkInlineCommentError.stack)}
    `);
  }

  // Unwrap "Content-Transfer-Encoding: quoted-printable" text which has
  // lines soft-wrapped at 76 characters and split up with `=\n`.
  //
  // > The Quoted-Printable encoding REQUIRES that encoded lines be no
  // > more than 76 characters long. If longer lines are to be encoded
  // > with the Quoted-Printable encoding, 'soft' line breaks must be
  // > used. An equal sign as the last character on a encoded line
  // > indicates such a non-significant ('soft') line break in the encoded
  // > text."
  // >
  // > https://www.w3.org/Protocols/rfc1341/5_Content-Transfer-Encoding.html
  const unwrappedEmailContents = reportedEmailContents.replace(/=\n/gm, '');

  return unwrappedEmailContents;
}

// Look for the /unsubscribe link in the email and decipher it to find the userId.
// ex. https://gitter.im/settings/unsubscribe/5cd788edba69ca1604f1536d71eb5aed540cd87cc3d4c21ee5a7ecfbf852987c459c26fe127f20cf9eca2fb2d2fc1262f
async function _unsubscribeUsersBasedOnUnsubscribeHashInEmail(ticketId, reportedEmailContents) {
  assert(ticketId);
  assert(reportedEmailContents);

  const unsubscribeHashMatches = reportedEmailContents.match(
    /"https:\/\/gitter.im\/settings\/unsubscribe\/(.*?)"/m
  );

  if (unsubscribeHashMatches) {
    const hash = unsubscribeHashMatches[1];
    const { userId } = unsubscribeHashes.decipherHash(hash);

    await unsubscribeUserId(userId);

    const user = await userService.findById(userId);

    await updateTicketWithUnsubscribedUsers(ticketId, [user]);
  } else {
    throw new Error(
      `Unable to find the https://gitter.im/settings/unsubscribe/xxx link in the reported .eml for ticketId=${ticketId}`
    );
  }
}

async function _unsubscribeUsersBasedOnToField(ticketId, reportedEmailContents) {
  assert(ticketId);
  assert(reportedEmailContents);

  const emailMatches = reportedEmailContents.match(/^To: (.*?)$/m);

  if (emailMatches) {
    const email = emailMatches[1];
    const unsubscribedUsers = await unsubscribeEmail(email);

    if (!unsubscribedUsers.length) {
      throw new Error(
        `Unable to find any Gitter users associated with this spam complaint. You probably just want to close this ticket but we've left it open for you to review.`
      );
    }

    await updateTicketWithUnsubscribedUsers(ticketId, unsubscribedUsers);
  } else {
    throw new Error(`Unable to find the To: field in the reported .eml for ticketId=${ticketId}`);
  }
}

async function unsubscribeUsersFromReportedEmailContents(ticketId, reportedEmailContents) {
  assert(ticketId);
  assert(reportedEmailContents);

  let checkUnsubscribeHashError;
  try {
    // First check for a possible Gitter /unsubscribe hash in the email and try using that
    await _unsubscribeUsersBasedOnUnsubscribeHashInEmail(ticketId, reportedEmailContents);
  } catch (err) {
    checkUnsubscribeHashError = err;
  }

  let checkToFieldError;
  if (checkUnsubscribeHashError) {
    try {
      // Not all emails have the /unsubscribe link so fallback
      // to checking the To: field (where the email was sent to).
      // This isn't 100% reliable though as we sometimes find emails
      // where the email isn't associated any of our Gitter users
      // (probably some internal email rewriting routing).
      await _unsubscribeUsersBasedOnToField(ticketId, reportedEmailContents);
    } catch (err) {
      checkToFieldError = err;
    }
  }

  if (checkUnsubscribeHashError && checkToFieldError) {
    throw new Error(`
Unable to find anyone to unsubscribe from this spam complaint.
We checked the for an /unsubscribe hash but ran into this problem:

${indent(checkUnsubscribeHashError.stack)}

We also checked for any users associated with the email defined in the To: field but ran into this problem:

${indent(checkToFieldError.stack)}
    `);
  }
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

      const comment = ticketCommentGetRes.body.comments[0];
      const reportedEmailContents = await getReportedEmailContentsFromComment(ticketId, comment);

      await unsubscribeUsersFromReportedEmailContents(ticketId, reportedEmailContents);
    } catch (err) {
      // Log the error and move on to the next ticket
      const errorMessage = `Failed to process ticketId=${ticketId}: ${err.stack}`;
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
    logger.info('Error', err.stack);
  } finally {
    shutdown.shutdownGracefully();
  }
})();
