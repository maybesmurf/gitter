"use strict";

var StatusError = require('statuserror');
var fonts = require('../../web/fonts');
var forumService = require('gitter-web-forums').forumService;
var forumCategoryStore = require('gitter-web-topics-ui/server/stores/forum-category-store')

function renderForum(req, res, next) {

  if (!req.fflip || !req.fflip.has('topics')) {
    return next(new StatusError(404));
  }

  forumService.findByName(req.params.roomPart1)
    .then(function(forum){
      res.render('topics/forum', {
        layout: 'topics-layout',
        hasCachedFonts: fonts.hasCachedFonts(req.cookies),
        fonts: fonts.getFonts(),
        componentData: {
          groupName: req.params.roomPart1,
          forum: forum,
          categoryStore: forumCategoryStore(forum.categories),
        }
      });
    });
}

module.exports = {
  renderForum: renderForum,
};
