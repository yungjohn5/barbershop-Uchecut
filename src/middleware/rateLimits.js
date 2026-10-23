const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('../lib/errors');

const common = { standardHeaders: 'draft-8', legacyHeaders: false };
const skip = () => process.env.NODE_ENV === 'test';

/** Minutes until the limit resets, rounded up (at least 1). */
const minutesLeft = (req) => {
  const reset = req.rateLimit && req.rateLimit.resetTime;
  return reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 60_000)) : 15;
};

// Hand limit hits to the error handler, so pages get the branded error page and the JSON
// API gets the usual { error: { code, message } } shape (the booking widget shows it).
const toError = (message) => (req, _res, next) =>
  next(new HttpError(429, message(minutesLeft(req)), { code: 'RATE_LIMITED' }));

// JSON endpoints used by the booking widget (slots are fetched as the user browses dates).
const apiLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 60,
  skip,
  handler: toError(() => 'You’re browsing times very quickly. Wait a moment and try again.'),
});

// Booking submissions and manage-link actions.
const bookingLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 10,
  skip,
  handler: toError(
    (min) =>
      `Too many booking attempts from this connection. Please try again in ${min} minute${min === 1 ? '' : 's'}, or message us on WhatsApp and we’ll book you in.`,
  ),
});

// Admin login (account lockout after 5 failures is enforced separately). The sign-in page
// is shown again with the message, rather than a bare error page.
const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  skip,
  handler: (req, res) => {
    const min = minutesLeft(req);
    res.status(429).render('admin/login', {
      layout: 'layouts/admin',
      title: 'Sign in',
      flash: null,
      next: '/admin',
      email: String((req.body && req.body.email) || ''),
      error: `Too many sign-in attempts from this connection. Try again in ${min} minute${min === 1 ? '' : 's'}.`,
    });
  },
});

module.exports = { apiLimiter, bookingLimiter, loginLimiter, minutesLeft };
