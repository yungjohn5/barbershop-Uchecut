// The worker's jobs. Each is a plain async function taking { now, db } so tests can run them
// at any moment in time; src/jobs/worker.js schedules them.
const prisma = require('../lib/prisma');
const settingsService = require('../services/settings');
const notifications = require('../services/notifications');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const include = { services: true, barber: true, customer: true, zone: true };

// Reminder windows: [template, hours before start].
const REMINDER_WINDOWS = [
  ['reminder-24h', 24],
  ['reminder-2h', 2],
];

/** When the customer last heard about this time: created, confirmed or moved. */
function lastTouched(booking) {
  const times = [booking.createdAt];
  if (booking.confirmedAt) times.push(booking.confirmedAt);
  for (const e of booking.events || []) if (e.type === 'RESCHEDULED') times.push(e.createdAt);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

/**
 * Pure: which reminders are due for a CONFIRMED booking at `now`.
 * - 24h: start is within 24h but more than 2h away (the 2h reminder covers the rest).
 * - 2h:  start is within 2h.
 * Skipped when the booking was made, confirmed or moved inside that window (the customer
 * has just been messaged).
 */
function remindersDue(booking, now) {
  const left = booking.startsAt.getTime() - now.getTime();
  if (left <= 0) return [];
  const touched = lastTouched(booking).getTime();
  const out = [];
  for (const [template, hours] of REMINDER_WINDOWS) {
    const windowStart = booking.startsAt.getTime() - hours * HOUR;
    const inWindow = left <= hours * HOUR && (template !== 'reminder-24h' || left > 2 * HOUR);
    if (inWindow && touched <= windowStart) out.push(template);
  }
  return out;
}

/** Every 5 minutes: queue due reminders. Dedupe keys include the start time. */
async function queueReminders({ now = new Date(), db = prisma } = {}) {
  const bookings = await db.booking.findMany({
    where: { status: 'CONFIRMED', startsAt: { gt: now, lte: new Date(now.getTime() + DAY) } },
    include: {
      ...include,
      events: { where: { type: 'RESCHEDULED' }, select: { type: true, createdAt: true } },
    },
  });
  const shop = await settingsService.get('shop');
  let queued = 0;
  for (const b of bookings) {
    for (const template of remindersDue(b, now)) {
      const payload = notifications.payloadFor(b, { shop });
      const rows = notifications.customerRows(b, template, payload, `:${b.startsAt.toISOString()}`);
      queued += await notifications.enqueue(db, rows);
    }
  }
  return { queued };
}

/**
 * Every 5 minutes: cancel PENDING home requests that weren't confirmed by
 * homeAutoCancelHours before the start, and tell the customer and the owner.
 */
async function autoCancelHomeRequests({ now = new Date(), db = prisma } = {}) {
  const { homeAutoCancelHours } = await settingsService.getAll();
  const cutoff = new Date(now.getTime() + homeAutoCancelHours * HOUR);
  const due = await db.booking.findMany({
    where: { status: 'PENDING', type: 'HOME', startsAt: { lte: cutoff } },
    select: { id: true },
  });
  let cancelled = 0;
  for (const { id } of due) {
    const done = await db.$transaction(async (tx) => {
      // Guard against a staff confirmation landing at the same moment.
      const { count } = await tx.booking.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Not confirmed in time' },
      });
      if (!count) return false;
      await tx.bookingEvent.create({
        data: {
          bookingId: id,
          type: 'CANCELLED',
          actor: 'SYSTEM',
          note: `Not confirmed ${homeAutoCancelHours} h before the visit`,
        },
      });
      const booking = await tx.booking.findUnique({ where: { id }, include });
      await notifications.enqueueForEvent(tx, booking, 'AUTO_CANCELLED', { by: 'system' });
      return true;
    });
    if (done) cancelled += 1;
  }
  return { cancelled };
}

/** Daily: drop expired sessions and old SENT/SKIPPED messages (FAILED ones are kept). */
async function cleanup({ now = new Date(), db = prisma, keepDays = 90 } = {}) {
  const sessions = await db.$executeRaw`DELETE FROM "session" WHERE expire < ${now}`;
  const { count: messages } = await db.notification.deleteMany({
    where: {
      status: { in: ['SENT', 'SKIPPED'] },
      createdAt: { lt: new Date(now.getTime() - keepDays * DAY) },
    },
  });
  return { sessions, messages };
}

const sendDue = ({ now = new Date(), db = prisma } = {}) =>
  notifications.sendDue({ now, db, limit: 100 });

// id = advisory lock key; schedule in Africa/Lagos time.
const JOBS = [
  { id: 1, name: 'send-due', schedule: '* * * * *', run: sendDue },
  { id: 2, name: 'reminders', schedule: '*/5 * * * *', run: queueReminders },
  { id: 3, name: 'auto-cancel', schedule: '*/5 * * * *', run: autoCancelHomeRequests },
  { id: 4, name: 'cleanup', schedule: '0 3 * * *', run: cleanup },
];

module.exports = {
  JOBS,
  remindersDue,
  lastTouched,
  queueReminders,
  autoCancelHomeRequests,
  cleanup,
  sendDue,
};
