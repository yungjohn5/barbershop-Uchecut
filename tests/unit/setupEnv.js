// Unit tests never touch a database; provide just enough env for config/env.js.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://unit:unit@127.0.0.1:5432/unit_never_used';
process.env.SESSION_SECRET ||= 'unit-test-secret-unit-test-secret-0123456789';
// Existing notification tests cover the SMS path; tests/unit/smsOff.test.js covers it off.
process.env.SMS_ENABLED ||= 'true';
// Tests never send real email/SMS, whatever .env says (it may be NOTIFY_MODE=live in dev).
process.env.NOTIFY_MODE = 'log';
process.env.NOTIFY_ALLOWLIST = '';
process.env.OWNER_EMAIL = '';
