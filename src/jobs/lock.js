// Postgres advisory lock per job, held for the job's duration inside a transaction (so it is
// tied to one connection and released automatically, even if the process dies). The worker
// runs as a single PM2 instance; this is the safety net if two ever start.
const prisma = require('../lib/prisma');

const JOB_LOCK_NAMESPACE = 7342; // booking locks use 7341

/** Runs fn() if the lock is free; otherwise returns { skipped: true } without waiting. */
async function withJobLock(jobId, fn, { db = prisma, timeoutMs = 10 * 60_000 } = {}) {
  return db.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw`
        SELECT pg_try_advisory_xact_lock(${JOB_LOCK_NAMESPACE}::int, ${jobId}::int) AS locked`;
      if (!locked) return { skipped: true };
      return { skipped: false, result: await fn() };
    },
    { maxWait: 10_000, timeout: timeoutMs },
  );
}

module.exports = { withJobLock, JOB_LOCK_NAMESPACE };
