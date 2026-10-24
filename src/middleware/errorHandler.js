const logger = require('../lib/logger');
const { NotFoundError } = require('../lib/errors');
const { DEFAULT_SETTINGS } = require('../config/constants');
const env = require('../config/env');

const wantsJson = (req) =>
  req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';

// The internal route is only shown while developing; visitors get a plain message.
function notFound(req, _res, next) {
  next(
    new NotFoundError(
      env.isDev
        ? `No route for ${req.method} ${req.path}`
        : 'This page doesn’t exist or may have moved.',
    ),
  );
}

function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = err.code;
  if (err.code === 'EBADCSRFTOKEN') {
    status = 403;
    code = 'CSRF';
  }
  const expose = status < 500 && err.expose !== false;
  const message = expose ? err.message : 'Something went wrong on our side.';

  if (status >= 500)
    logger.error(
      { err, method: req.method, url: logger.safeUrl(req.originalUrl) },
      'request failed',
    );

  res.status(status);
  if (wantsJson(req)) {
    return res.json({
      error: { code: code || 'ERROR', message, details: expose ? err.details : undefined },
    });
  }
  // Errors can fire before the locals middleware ran (e.g. CSRF rejection).
  res.locals.shop ??= DEFAULT_SETTINGS.shop;
  res.locals.csrfToken ??= '';
  res.locals.page ??= null;
  res.locals.siteImg ??= (slot) => require('../lib/images').siteImage(slot, {});
  res.render(
    'pages/error',
    { title: status === 404 ? 'Page not found' : 'Error', status, message, noindex: true },
    (renderErr, html) => {
      if (renderErr) {
        logger.error({ err: renderErr }, 'failed to render error page');
        return res.type('text').send(message);
      }
      res.send(html);
    },
  );
}

module.exports = { notFound, errorHandler };
