const { csrfSync } = require('csrf-sync');

// Synchroniser-token CSRF: token stored in the session, sent back as a hidden
// `_csrf` form field or an `x-csrf-token` header (fetch requests).
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
});

// Expose the token to every view as `csrfToken`.
function exposeCsrfToken(req, res, next) {
  res.locals.csrfToken = generateToken(req);
  next();
}

module.exports = { csrfProtection: csrfSynchronisedProtection, exposeCsrfToken };
