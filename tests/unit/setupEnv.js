// Unit tests never touch a database; provide just enough env for config/env.js.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://unit:unit@127.0.0.1:5432/unit_never_used';
process.env.SESSION_SECRET ||= 'unit-test-secret-unit-test-secret-0123456789';
