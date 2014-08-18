/*jshint globalstrict: true, trailing: false, unused: true, node: true */
"use strict";

var env = require('../utils/env');
var config          = env.config;

var express        = require('express');
var passport       = require('passport');
var expressHbs     = require('express-hbs');
var expressSession = require('express-session');
var path           = require('path');
var rememberMe     = require('./middlewares/rememberme-middleware');
var I18n           = require('i18n-2');

// Naughty naughty naught, install some extra methods on the express prototype
require('./http');

var staticContentDir = path.join(__dirname, '..', '..', config.get('web:staticContent'));

module.exports = {
  /**
   * Configure express for the full web application
   */
  installFull: function(app, server, sessionStore) {
    expressHbs.registerHelper('cdn', require('./hbs-helpers').cdn);
    expressHbs.registerHelper('bootScript', require('./hbs-helpers').bootScript);
    expressHbs.registerHelper('isMobile', require('./hbs-helpers').isMobile);
    expressHbs.registerHelper('generateEnv', require('./hbs-helpers').generateEnv);
    expressHbs.registerHelper('generateTroupeContext', require('./hbs-helpers').generateTroupeContext);
    expressHbs.registerAsyncHelper('prerenderView', require('./prerender-helper'));
    expressHbs.registerHelper('chatItemPrerender', require('./prerender-chat-helper'));
    expressHbs.registerHelper('pluralize', require('./hbs-helpers').pluralize);

    app.locals({
      googleTrackingId: config.get("web:trackingId"),
      liveReload: config.get('web:liveReload')
    });

    app.engine('hbs', expressHbs.express3({
      partialsDir: staticContentDir + '/templates/partials',
      layoutsDir: staticContentDir + '/layouts',
      contentHelperName: 'content'
    }));

    app.disable('x-powered-by');
    app.set('view engine', 'hbs');
    app.set('views', staticContentDir + '/templates');
    app.set('trust proxy', true);

    if(config.get('express:viewCache')) {
      app.enable('view cache');
    }

    app.use(express.static(staticContentDir, {
      maxAge: config.get('web:staticContentExpiryDays') * 86400 * 1000
    }));

    app.use(env.middlewares.accessLogger);

    app.use(express.cookieParser());
    app.use(express.urlencoded());
    app.use(express.json());
    app.use(express.methodOverride());
    app.use(require('./middlewares/ie6-post-caching'));

    I18n.expressBind(app, {
      locales: ['en', 'fr', 'ja', 'de', 'ru', 'es', 'zh', 'pt', 'it', 'nl', 'sv', 'cs', 'pl', 'da', 'ko'],
      devMode: config.runtimeEnvironment === 'dev',
      directory: path.join(__dirname, '..', '..', 'locales')
    });

    /* Blanket Middlewares */
    app.use(function(req, res, next) {
      /*  Setup i18n */
      if(req.i18n && req.i18n.prefLocale) {
        req.i18n.setLocale(req.i18n.prefLocale);
      }

      /* i18n stuff */
      res.locals.locale = req.i18n;
      res.locals.lang = req.i18n && req.i18n.locale || 'en';

      /* Setup minify switch */
      if(req.query.minified === '0') {
        res.locals.minified = false;
      }
      next();
    });

    app.use(expressSession({
      secret: config.get('web:sessionSecret'),
      key: config.get('web:cookiePrefix') + 'session',
      store: sessionStore,
      cookie: {
        path: '/',
        httpOnly: true,
        maxAge: 14400000,
        domain: config.get("web:cookieDomain"),
        secure: false /*config.get("web:secureCookies")*/ // TODO: fix this!!
      }
    }));

    app.use(passport.initialize());
    app.use(passport.session());

    app.use(require('./middlewares/authenticate-bearer'));
    app.use(rememberMe.rememberMeMiddleware);
    app.use(require('./middlewares/rate-limiter'));

    app.use(require('./middlewares/configure-csrf'));
    app.use(require('./middlewares/enforce-csrf'));

    app.use(require('./middlewares/tokenless-user'));

    app.use(app.router);

    app.use(require('./middlewares/token-error-handler'));
    app.use(require('./middlewares/express-error-handler'));
  },

  installApi: function(app) {
    app.disable('x-powered-by');
    app.set('trust proxy', true);

    app.use(env.middlewares.accessLogger);

    app.use(express.urlencoded());
    app.use(express.json());
    app.use(express.methodOverride());

    app.use(require('./middlewares/ie6-post-caching'));

    app.use(passport.initialize());
    app.use(app.router);

    app.use(require('./middlewares/token-error-handler'));
    app.use(env.middlewares.errorHandler);
  },

  installSocket: function(app) {
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    app.use(env.middlewares.accessLogger);
    app.use(express.cookieParser());
    app.use(express.urlencoded());
    app.use(express.json());

    app.use(require('./middlewares/token-error-handler'));
    app.use(env.middlewares.errorHandler);
  }
};
