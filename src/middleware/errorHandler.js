const logger = require('../lib/logger');
const { NotFoundError } = require('../lib/errors');
const { DEFAULT_SETTINGS } = require('../config/constants');

const wantsJson = (req) =>
  req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';

function notFound(req, _res, next) {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
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

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl}`, err);

  res.status(status);
  if (wantsJson(req)) {
    return res.json({
      error: { code: code || 'ERROR', message, details: expose ? err.details : undefined },
    });
  }
  // Errors can fire before the locals middleware ran (e.g. CSRF rejection).
  res.locals.shop ??= DEFAULT_SETTINGS.shop;
  res.locals.csrfToken ??= '';
  res.render(
    'pages/error',
    { title: status === 404 ? 'Page not found' : 'Error', status, message },
    (renderErr, html) => {
      if (renderErr) {
        logger.error('Failed to render error page', renderErr);
        return res.type('text').send(message);
      }
      res.send(html);
    },
  );
}

module.exports = { notFound, errorHandler };
