const env = require('./config/env');
const logger = require('./lib/logger');
const prisma = require('./lib/prisma');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`Listening on ${env.APP_URL} (port ${env.PORT}, ${env.NODE_ENV})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), app.locals.sessionPool.end()]);
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
