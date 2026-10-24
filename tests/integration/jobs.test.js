// Worker jobs against the test database: reminders, auto-cancel, cleanup, the advisory lock,
// and `worker:once` as a real separate process.
const path = require('path');
const { execFile } = require('child_process');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createBooking, rescheduleBooking } = require('../../src/services/booking');
const adminBookings = require('../../src/services/adminBookings');
const { queueReminders, autoCancelHomeRequests, cleanup } = require('../../src/jobs/tasks');
const { withJobLock } = require('../../src/jobs/lock');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');

const H = 3_600_000;
let fx;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});
afterAll(() => prisma.$disconnect());

const DAY = (n) => addDays(toShopDate(new Date()), n);
const book = (o = {}) =>
  createBooking({
    type: o.type || 'SHOP',
    serviceIds: [fx.cut.id],
    zoneId: o.type === 'HOME' ? fx.zone.id : null,
    barberId: fx.homeBarber.id,
    startsAt: wallClockToUtc(o.date || DAY(3), o.min ?? 660).toISOString(),
    customer: { name: 'Kemi Ade', phone: '08030000001', email: 'kemi@example.com' },
    address: o.type === 'HOME' ? '1 Test Rd' : undefined,
  });
const reminders = (bookingId) =>
  prisma.notification.findMany({
    where: { bookingId, template: { startsWith: 'reminder' } },
    orderBy: { id: 'asc' },
  });

describe('reminders', () => {
  test('24 h reminder by SMS + email, 2 h reminder by SMS only, each exactly once', async () => {
    const b = await book();
    const before = (h) => new Date(b.startsAt.getTime() - h * H);

    expect(await queueReminders({ now: before(30) })).toEqual({ queued: 0 });
    await queueReminders({ now: before(23) });
    await queueReminders({ now: before(22) }); // runs every 5 min: no duplicates
    let rows = await reminders(b.id);
    expect(rows.map((r) => [r.template, r.channel])).toEqual([
      ['reminder-24h', 'SMS'],
      ['reminder-24h', 'EMAIL'],
    ]);
    expect(rows[0].dedupeKey).toBe(`${b.reference}:reminder-24h:SMS:${b.startsAt.toISOString()}`);

    await queueReminders({ now: before(1.5) });
    await queueReminders({ now: before(1) });
    rows = await reminders(b.id);
    expect(rows.filter((r) => r.template === 'reminder-2h').map((r) => r.channel)).toEqual(['SMS']);
  });

  test('pending home requests and cancelled bookings get no reminders', async () => {
    const home = await book({ type: 'HOME' });
    const shop = await book({ min: 780 });
    await adminBookings.applyAction(shop.id, 'cancel', {});
    await queueReminders({ now: new Date(home.startsAt.getTime() - 20 * H) });
    expect(await reminders(home.id)).toHaveLength(0);
    expect(await reminders(shop.id)).toHaveLength(0);
  });

  test('after a move, old unsent reminders are skipped and new ones follow the new time', async () => {
    const b = await book();
    await prisma.notification.create({
      data: {
        bookingId: b.id,
        channel: 'SMS',
        template: 'reminder-24h',
        to: '+2348030000001',
        payload: {},
        dedupeKey: `${b.reference}:reminder-24h:SMS:${b.startsAt.toISOString()}`,
        sendAfter: new Date(Date.now() + 3600_000),
      },
    });
    const to = wallClockToUtc(DAY(4), 660);
    await rescheduleBooking(b.manageToken, {
      startsAt: to.toISOString(),
      barberId: String(fx.homeBarber.id),
    });
    await queueReminders({ now: new Date(to.getTime() - 23 * H) });
    const rows = await reminders(b.id);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED' });
    expect(rows.filter((r) => r.status === 'PENDING').map((r) => r.dedupeKey)).toEqual([
      `${b.reference}:reminder-24h:SMS:${to.toISOString()}`,
      `${b.reference}:reminder-24h:EMAIL:${to.toISOString()}`,
    ]);
  });
});

describe('auto-cancel', () => {
  test('a home request still pending 12 h before the visit is cancelled and both sides are told', async () => {
    const b = await book({ type: 'HOME' });
    const confirmed = await book({ type: 'HOME', min: 900 });
    await adminBookings.applyAction(confirmed.id, 'confirm', {});

    expect(await autoCancelHomeRequests({ now: new Date(b.startsAt.getTime() - 13 * H) })).toEqual({
      cancelled: 0,
    });
    expect(await autoCancelHomeRequests({ now: new Date(b.startsAt.getTime() - 11 * H) })).toEqual({
      cancelled: 1,
    });

    const after = await prisma.booking.findUnique({
      where: { id: b.id },
      include: { events: true },
    });
    expect(after).toMatchObject({ status: 'CANCELLED', cancelReason: 'Not confirmed in time' });
    expect(after.events.at(-1)).toMatchObject({ type: 'CANCELLED', actor: 'SYSTEM' });
    const msgs = await prisma.notification.findMany({
      where: { bookingId: b.id, template: { in: ['auto-cancelled', 'owner-cancelled'] } },
    });
    expect(msgs.map((m) => m.template).sort()).toEqual([
      'auto-cancelled',
      'auto-cancelled',
      'owner-cancelled',
    ]);
    expect(msgs.find((m) => m.template === 'auto-cancelled').payload.manageUrl).toContain(
      b.manageToken,
    );
    // the confirmed one is untouched, and running again changes nothing
    expect((await prisma.booking.findUnique({ where: { id: confirmed.id } })).status).toBe(
      'CONFIRMED',
    );
    expect(await autoCancelHomeRequests({ now: new Date(b.startsAt.getTime() - 10 * H) })).toEqual({
      cancelled: 0,
    });
  });
});

describe('cleanup', () => {
  test('drops expired sessions and old SENT/SKIPPED messages, keeps FAILED and recent ones', async () => {
    const b = await book();
    const old = new Date(Date.now() - 100 * 24 * H);
    await prisma.notification.updateMany({
      where: { bookingId: b.id },
      data: { status: 'SENT', createdAt: old },
    });
    const [keepFailed] = await prisma.notification.findMany({
      where: { bookingId: b.id },
      take: 1,
    });
    await prisma.notification.update({ where: { id: keepFailed.id }, data: { status: 'FAILED' } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "session" (sid, sess, expire) VALUES ('gone', '{}', now() - interval '1 day'), ('live', '{}', now() + interval '1 day')`,
    );
    const out = await cleanup();
    expect(out).toEqual({ sessions: 1, messages: 2 });
    expect(await prisma.notification.count({ where: { bookingId: b.id } })).toBe(1);
    expect(await prisma.session.count({ where: { sid: 'live' } })).toBe(1);
    await prisma.$executeRawUnsafe(`DELETE FROM "session" WHERE sid = 'live'`);
  });
});

describe('worker', () => {
  test('the advisory lock lets only one run of a job at a time', async () => {
    let release;
    const first = withJobLock(99, () => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 300));
    expect(await withJobLock(99, async () => 'second')).toEqual({ skipped: true });
    release('done');
    expect(await first).toEqual({ skipped: false, result: 'done' });
    expect(await withJobLock(99, async () => 'third')).toEqual({ skipped: false, result: 'third' });
  });

  test('worker:once runs every job in a separate process and exits cleanly', async () => {
    const b = await book();
    const { code, stdout, stderr } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, '../../src/jobs/worker.js'), '--once'],
        { env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info' }, timeout: 60_000 },
        (err, out, errOut) => resolve({ code: err ? err.code : 0, stdout: out, stderr: errOut }),
      );
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('send-due');
    // the booking's confirmation messages went out in log mode
    const sent = await prisma.notification.findMany({ where: { bookingId: b.id } });
    expect(sent.every((n) => n.status === 'SENT' && n.providerRef === 'log')).toBe(true);
  });
});
