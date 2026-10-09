// Resolves and guards the integration-test database URL.
require('dotenv').config({ quiet: true });

function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set (see .env.example). Integration tests need it.');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${dbName}": name must end in _test.`,
    );
  }
  return { url, dbName };
}

module.exports = { testDatabaseUrl };
