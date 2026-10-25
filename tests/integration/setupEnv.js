// Runs in each integration worker before any app module loads, so Prisma and
// config/env.js bind to the test database, never the dev one.
const { testDatabaseUrl } = require('./testDb');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl().url;
// Existing notification tests cover the SMS path; tests/unit/smsOff.test.js covers it off.
process.env.SMS_ENABLED ||= 'true';
// Tests never send real email/SMS, whatever .env says (it may be NOTIFY_MODE=live in dev).
process.env.NOTIFY_MODE = 'log';
process.env.NOTIFY_ALLOWLIST = '';
process.env.OWNER_EMAIL = '';
