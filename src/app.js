const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const pinoHttp = require('pino-http');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const expressLayouts = require('express-ejs-layouts');

const env = require('./config/env');
const { csrfProtection, exposeCsrfToken } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const settingsService = require('./services/settings');
const prisma = require('./lib/prisma');
const logger = require('./lib/logger');
const { homeVisitsOpen } = require('./services/content');

function createApp({ sessionPool } = {}) {
  const app = express();
  const pool = sessionPool || new Pool({ connectionString: env.DATABASE_URL, max: 5 });

  app.set('trust proxy', 1); // behind Nginx in production: real client IP for rate limits, secure cookies
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');
  app.set('layout', 'layouts/main');
  app.use(expressLayouts);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          // Cloudinary serves every uploaded image; blob: previews admin uploads.
          'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': env.isProd ? [] : null,
        },
      },
      // HSTS only in production (HTTPS via Nginx); never pin localhost to HTTPS.
      strictTransportSecurity: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());
  // Request logs without PII: cleaned URLs, no headers/cookies, no static-file noise.
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => /^\/(css|js|vendor|images|uploads|favicon|healthz)/.test(req.url),
      },
      serializers: {
        req: (req) => ({ method: req.method, url: logger.safeUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customSuccessMessage: (req, res, ms) =>
        `${req.method} ${logger.safeUrl(req.url)} ${res.statusCode} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res) =>
        `${req.method} ${logger.safeUrl(req.url)} ${res.statusCode}`,
    }),
  );

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: env.isProd ? '7d' : 0 }));
  // GSAP served from node_modules so the CSP can stay script-src 'self'.
  app.use(
    '/vendor/gsap',
    express.static(path.join(__dirname, '..', 'node_modules', 'gsap', 'dist'), {
      maxAge: env.isProd ? '30d' : 0,
    }),
  );
  Object.assign(app.locals, require('./lib/viewHelpers'));
  app.locals.credits = require('./config/credits'); // builder section + footer credit
  const images = require('./lib/images');
  Object.assign(app.locals, {
    imageOf: images.imageOf,
    imageUrl: images.imageUrl,
    srcset: images.srcset,
  });
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));

  // Health check for Nginx/PM2/uptime monitors: 200 if the database answers, else 503.
  app.get('/healthz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));

  // JSON API: read-only GETs, no session or CSRF needed.
  app.use('/api', require('./routes/api'));

  app.use(
    session({
      store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
      name: 'vb.sid',
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.isProd,
        maxAge: 1000 * 60 * 60 * 8,
      },
    }),
  );

  // Admin image forms are multipart: parse them first so CSRF can read the _csrf field.
  app.use('/admin', require('./middleware/upload').parseMultipart);
  app.use(csrfProtection); // enforced on POST/PUT/PATCH/DELETE only
  app.use(exposeCsrfToken);
  app.use(async (req, res, next) => {
    try {
      res.locals.shop = await settingsService.get('shop');
      const siteImages = await settingsService.get('siteImages');
      res.locals.siteImg = (slot) => require('./lib/images').siteImage(slot, siteImages);
      // Public pages hide home-visit buttons when nobody can take one (see services/content.js).
      res.locals.homeOpen = req.path.startsWith('/admin') ? true : await homeVisitsOpen();
      res.locals.currentPath = req.path;
      res.locals.page = null; // pages set their own, e.g. 'home'
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/public'));
  app.use('/', require('./routes/booking'));

  app.use(notFound);
  app.use(errorHandler);

  app.locals.sessionPool = pool;
  return app;
}

module.exports = { createApp };
