// Background worker: a SEPARATE process from the web app (PM2 runs one instance), so jobs
// never run once per web worker. Each job also takes a Postgres advisory lock.
//   npm run worker        → schedule jobs (Africa/Lagos time)
//   npm run worker:once   → run every job once, then exit (for testing)
const cron = require('node-cron');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { TIMEZONE } = require('../config/constants');
const { withJobLock } = require('./lock');
const { JOBS } = require('./tasks');

const running = new Set();

async function runJob(job) {
  if (running.has(job.name)) return; // previous run still going in this process
  running.add(job.name);
  const started = Date.now();
  try {
    const out = await withJobLock(job.id, () => job.run({ now: new Date() }));
    if (out.skipped) logger.info({ job: job.name }, 'job skipped: lock held elsewhere');
    else logger.info({ job: job.name, ms: Date.now() - started, ...out.result }, 'job done');
  } catch (err) {
    logger.error({ job: job.name, err: err.message }, 'job failed');
  } finally {
    running.delete(job.name);
  }
}

async function runOnce() {
  for (const job of JOBS) await runJob(job);
  await prisma.$disconnect();
}

function start() {
  const tasks = JOBS.map((job) =>
    cron.schedule(job.schedule, () => runJob(job), { timezone: TIMEZONE }),
  );
  logger.info({ jobs: JOBS.map((j) => `${j.name} (${j.schedule})`) }, 'worker started');
  const stop = async (signal) => {
    logger.info({ signal }, 'worker stopping');
    tasks.forEach((t) => t.stop());
    const deadline = Date.now() + 30_000;
    while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  if (process.argv.includes('--once')) {
    runOnce().then(
      () => process.exit(0),
      (err) => {
        logger.error({ err: err.message }, 'worker:once failed');
        process.exit(1);
      },
    );
  } else {
    start();
  }
}

module.exports = { runJob, runOnce };
