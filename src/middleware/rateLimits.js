const { rateLimit } = require('express-rate-limit');

const common = { standardHeaders: 'draft-8', legacyHeaders: false };
const skip = () => process.env.NODE_ENV === 'test';

// JSON endpoints used by the booking widget (slots are fetched as the user browses dates).
const apiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 60, skip });

// Booking submissions and manage-link actions.
const bookingLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 10, skip });

// Admin login (account lockout after 5 failures is enforced separately, Phase 4).
const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 20, skip });

module.exports = { apiLimiter, bookingLimiter, loginLimiter };
