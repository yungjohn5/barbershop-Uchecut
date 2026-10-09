// Creates the test database if needed and applies all migrations to it.
const { execSync } = require('child_process');
const { Client } = require('pg');
const { testDatabaseUrl } = require('./testDb');

module.exports = async () => {
  const { url, dbName } = testDatabaseUrl();

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
};
