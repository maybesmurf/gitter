/*jshint globalstrict:true, trailing:false, unused:true, node:true */
"use strict";

var env           = require('../utils/env');
var stats         = env.stats;
var logger        = env.logger;

var persistence   = require("./persistence-service");
var userService   = require("./user-service");
var _             = require('underscore');
var Q             = require('q');

function indexImportsByEmail(contacts) {
  var result = {};
  contacts.forEach(function(contact) {
    contact.emails.forEach(function(email) {
      email = email.toLowerCase();

      var a = result[email];
      if(!a) {
        a = [];
        result[email] = a;
      }

      a.push(contact);
    });
  });

  return result;
}

exports.ingestGoogleContacts = function(user, data, cb) {
  var contacts = [];

  if (data.feed && data.feed.entry) {
    _.each(data.feed.entry, function(entry) {

      var emails = _.inject(entry.gd$email, function(accum, email) {
        accum.push(email.address);
        return accum;
      }, []);

      var id   = entry.id.$t;
      var name = entry.title.$t || emails[0];

      if (emails.length > 0) contacts.push({id: id, name: name, emails: emails});
    });
  }

  logger.verbose('[contact] Importing contacts: ', contacts.length);

  var importsByEmail = indexImportsByEmail(contacts);
  var emails = Object.keys(importsByEmail);

  // Try find any existing users with these email addresses
  return userService.findByEmailsIndexed(emails)
    .then(function(usersIndexed) {

      // Map contactUserId for any existing contacts
      emails.forEach(function(importedEmail) {
        var existingUser = usersIndexed[importedEmail];
        if(!existingUser) return;

        var contacts = importsByEmail[importedEmail];
        contacts.forEach(function(contact) {
          contact.contactUserId = existingUser._id;
        });
      });

      return contacts;
    })
    .then(function(contacts) {
      // Save the contacts to the DB
      return Q.all(contacts.map(function(contact) {
        var newContact = {
          userId        : user._id,
          source        : 'google',
          sourceId      : contact.id,
          name          : contact.name,
          emails        : contact.emails
        };

        if(contact.contactUserId) {
          newContact.contactUserId = contact.contactUserId;
        }

        return persistence.Contact.findOneAndUpdateQ(
            { source: newContact.source, sourceId: newContact.sourceId },
            { $set: newContact },
            { upsert: true })
          .thenResolve(newContact);
      }));
    })
    .then(function(imported) {
      if (imported.length > 0) {
        stats.userUpdate(user, {'import_contacts': 'Google'});
        stats.event('import_contacts', {'userId': user.id});
      }
      return imported;
    })
    .nodeify(cb);
};

exports.find = function(user, pattern, cb) {
  var re    = new RegExp("\\b" + pattern, "i");
  var query = {'userId': user.id, $or: [{name: re}, {emails: re}]};

  return persistence.Contact.find(query)
    .execQ()
    .then(function(contacts) {
      return contacts.map(function(contact) {
        return {
          displayName:    contact.name,
          email:          contact.emails[0],
          avatarUrlSmall: '/avatarForEmail/' + contact.emails[0],
          imported:       true
        };
      });
    })
    .nodeify(cb);
};


exports.findContactsForUserId = function(userId, callback) {
  return persistence.Contact.find({ userId: userId })
    .execQ()
    .nodeify(callback);
};

exports.findReverseContactsForUserId = function(userId, callback) {
  return persistence.Contact.find({ contactUserId: userId })
    .execQ()
    .nodeify(callback);
};

exports.importedGoogleContacts = function(user, cb) {
  var query = {'userId': user.id, source: 'google'};

  return persistence.Contact.findOne(query)
    .execQ()
    .then(function(contact) {
        return !!contact;
    })
    .nodeify(cb);
};

/**
 * Finds all contacts with the given email address and updates the contact with the userId of the
 * user that contact belongs to.
 *
 * @return promise of contacts
 */
exports.updateContactsWithUserId = function(email, userId) {
  return persistence.Contact.find({ emails: email, contactUserId: { $exists: false } })
    .execQ()
    .then(function(contacts) {
      logger.silly('Updating ' + contacts.length + ' contacts with userId');

      // Update and save all matching contacts
      return Q.all(contacts.map(function(contact) {
          contact.contactUserId = userId;
          return contact.saveQ();
        }))
        .thenResolve(contacts);
    });
};
