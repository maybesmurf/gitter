/*jshint globalstrict: true, trailing: false, unused: true, node: true */
"use strict";

var middleware      = require('../../web/middleware');
var appRender       = require('./render');
var appMiddleware   = require('./middleware');
var limitedReleaseService = require('../../services/limited-release-service');

module.exports = {
    install: function(app) {
      app.get('/:userOrOrg',
        middleware.grantAccessForRememberMeTokenMiddleware,
        middleware.ensureLoggedIn(),
        appMiddleware.uriContextResolverMiddleware,
        appMiddleware.isPhoneMiddleware,
        function(req, res, next) {
          if (req.uriContext.ownUrl) {
            return limitedReleaseService.shouldUserBeTurnedAway(req.user)
              .then(function(allow) {
                if(allow) {
                  appRender.renderMainFrame(req, res, next, 'home');
                } else {
                  var email = req.user.emails[0];
                  return res.render('thanks', { email: email, userEmailAccess: req.user.hasGitHubScope('user:email') });
                }
              })
              .fail(next);
          }

          appRender.renderMainFrame(req, res, next, 'chat');
        });

    app.get('/:userOrOrg/-/home',
      middleware.grantAccessForRememberMeTokenMiddleware,
      middleware.ensureLoggedIn(),
      appMiddleware.uriContextResolverMiddleware,
      appMiddleware.isPhoneMiddleware,
      function(req, res, next) {
        appRender.renderHomePage(req, res, next);
      });

    app.get('/:userOrOrg/-/chat',
      middleware.grantAccessForRememberMeTokenMiddleware,
      middleware.ensureLoggedIn(),
      appMiddleware.uriContextResolverMiddleware,
      appMiddleware.isPhoneMiddleware,
      function(req, res, next) {
        appRender.renderAppPageWithTroupe(req, res, next, 'chat');
      });

      app.get('/:userOrOrg/:repo',
        middleware.grantAccessForRememberMeTokenMiddleware,
        middleware.ensureLoggedIn(),
        appMiddleware.uriContextResolverMiddleware,
        appMiddleware.isPhoneMiddleware,
        function(req, res, next) {
          appRender.renderMainFrame(req, res, next, 'chat');
        });

      app.get('/:userOrOrg/:repo/chat',
        middleware.grantAccessForRememberMeTokenMiddleware,
        middleware.ensureLoggedIn(),
        appMiddleware.uriContextResolverMiddleware,
        appMiddleware.isPhoneMiddleware,
        function(req, res, next) {
          appRender.renderAppPageWithTroupe(req, res, next, 'chat');
        });



      // require('./native-redirects').install(app);
      require('./integrations').install(app);
    }
};
