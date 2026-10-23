// Outbox: messages are queued in the booking's own transaction, deduplicated, delivered by
// sendDue() with retries/backoff, and NOTIFY_MODE=log never calls a provider.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const env = require('../../src/config/env');
const sms = require('../../src/lib/sms');
const mailer = require('../../src/lib/mailer');
const notifications = require('../../src/services/notifications');
const adminBookings = require('../../src/services/adminBookings');
const { createBooking, rescheduleBooking, cancelBooking } = require('../../src/services/booking');
const { hashPassword } = require('../../src/services/adminAuth');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');

let fx;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
  env.notifyAllowlist = [];
  jest.restoreAllMocks();
});
afterAll(() => prisma.$disconnect());

const DAY = (n) => addDays(toShopDate(new Date()), n);
const book = (o = {}) =>
  createBooking(
    {
      type: o.type || 'SHOP',
      serviceIds: [fx.cut.id],
      zoneId: o.type === 'HOME' ? fx.zone.id : null,
      barberId: fx.homeBarber.id,
      startsAt: wallClockToUtc(o.date || DAY(3), o.min ?? 660).toISOString(),
      customer: {
        name: 'Kemi Ade',
        phone: '08030000001',
        email: o.email === undefined ? 'kemi@example.com' : o.email,
      },
      address: o.type === 'HOME' ? '1 Test Rd' : undefined,
    },
    { actor: o.actor || 'customer' },
  );
const rows = (bookingId) =>
  prisma.notification.findMany({ where: { bookingId }, orderBy: { id: 'asc' } });
const keys = async (bookingId) => (await rows(bookingId)).map((n) => n.dedupeKey);

describe('enqueue', () => {
  test('an online shop booking queues the customer SMS + email and an owner alert', async () => {
    const b = await book();
    expect(await keys(b.id)).toEqual([
      `${b.reference}:shop-confirmed:SMS`,
      `${b.reference}:shop-confirmed:EMAIL`,
      `${b.reference}:owner-new-booking:EMAIL`,
    ]);
    const [smsRow] = await rows(b.id);
    expect(smsRow).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      to: '+2348030000001',
      channel: 'SMS',
    });
    expect(smsRow.payload).toMatchObject({
      reference: b.reference,
      manageUrl: expect.stringContaining(`/manage/${b.manageToken}`),
    });
  });

  test('no email address → SMS only', async () => {
    const b = await book({ email: '' });
    expect(
      (await rows(b.id)).filter((n) => n.template === 'shop-confirmed').map((n) => n.channel),
    ).toEqual(['SMS']);
  });

  test('home request: "received" + owner alert; staff confirm sends "confirmed"', async () => {
    const b = await book({ type: 'HOME' });
    expect((await rows(b.id)).map((n) => n.template)).toEqual([
      'home-received',
      'home-received',
      'owner-home-request',
    ]);
    await adminBookings.applyAction(b.id, 'confirm', { adminName: 'Ada' });
    expect((await rows(b.id)).filter((n) => n.template === 'home-confirmed')).toHaveLength(2);
  });

  test('staff bookings are confirmed to the customer without an owner alert', async () => {
    const b = await book({ actor: 'staff' });
    expect((await rows(b.id)).map((n) => n.template)).toEqual(['shop-confirmed', 'shop-confirmed']);
  });

  test('dedupe: queuing the same event twice adds nothing', async () => {
    const b = await book();
    const full = await prisma.booking.findUnique({
      where: { id: b.id },
      include: { services: true, barber: true, customer: true, zone: true },
    });
    const added = await prisma.$transaction((tx) =>
      notifications.enqueueForEvent(tx, full, 'CREATED'),
    );
    expect(added).toBe(0);
    expect(await rows(b.id)).toHaveLength(3);
  });

  test('outbox rows roll back with the booking change', async () => {
    const b = await book();
    const before = await prisma.notification.count();
    await expect(
      prisma.$transaction(async (tx) => {
        const full = await tx.booking.findUnique({
          where: { id: b.id },
          include: { services: true, barber: true, customer: true, zone: true },
        });
        await tx.bookingEvent.create({
          data: { bookingId: b.id, type: 'CANCELLED', actor: 'STAFF' },
        });
        await notifications.enqueueForEvent(tx, full, 'CANCELLED', { by: 'staff' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.notification.count()).toBe(before);
  });

  test('a reschedule queues "rescheduled" and skips unsent reminders for the old time', async () => {
    const b = await book();
    await prisma.notification.create({
      data: {
        bookingId: b.id,
        channel: 'SMS',
        template: 'reminder-24h',
        to: '+2348030000001',
        payload: {},
        dedupeKey: `${b.reference}:reminder-24h:SMS:old`,
        sendAfter: new Date(Date.now() + 3600_000),
      },
    });
    const to = wallClockToUtc(DAY(3), 780).toISOString();
    await rescheduleBooking(b.manageToken, { startsAt: to, barberId: String(fx.homeBarber.id) });
    const all = await rows(b.id);
    expect(all.find((n) => n.template === 'reminder-24h')).toMatchObject({
      status: 'SKIPPED',
      lastError: 'Booking moved',
    });
    const moved = all.filter((n) => n.template === 'rescheduled');
    expect(moved).toHaveLength(2);
    expect(moved[0].payload.fromWhen).toBeTruthy();
  });

  test('customer cancel alerts the owner; staff cancel tells the customer the reason', async () => {
    const a = await book();
    await cancelBooking(a.manageToken, { reason: 'Travelling' });
    expect((await rows(a.id)).map((n) => n.template)).toEqual(
      expect.arrayContaining(['cancelled', 'cancelled', 'owner-cancelled']),
    );
    const b = await book({ min: 780 });
    await adminBookings.applyAction(b.id, 'cancel', { reason: 'Barber unwell', adminName: 'Ada' });
    const msgs = (await rows(b.id)).filter((n) => n.template.includes('cancelled'));
    expect(msgs.map((n) => n.template)).toEqual(['cancelled', 'cancelled']);
    expect(msgs[0].payload).toMatchObject({ by: 'staff', reason: 'Barber unwell' });
  });
});

describe('delivery', () => {
  test('NOTIFY_MODE=log records messages and never calls a provider', async () => {
    const smsSpy = jest.spyOn(sms, 'send');
    const mailSpy = jest.spyOn(mailer, 'sendMail');
    const b = await book();
    expect(env.NOTIFY_MODE).toBe('log');
    const counts = await notifications.sendDue();
    expect(counts.SENT).toBe(3);
    expect(smsSpy).not.toHaveBeenCalled();
    expect(mailSpy).not.toHaveBeenCalled();
    for (const n of await rows(b.id))
      expect(n).toMatchObject({ status: 'SENT', providerRef: 'log', attempts: 1 });
  });

  test('live outside production: recipients not on the allowlist are skipped', async () => {
    const smsSpy = jest.spyOn(sms, 'send').mockResolvedValue('x');
    const b = await book();
    await notifications.sendDue({ mode: 'live' });
    expect(smsSpy).not.toHaveBeenCalled();
    expect((await rows(b.id))[0]).toMatchObject({
      status: 'SKIPPED',
      lastError: expect.stringContaining('NOTIFY_ALLOWLIST'),
    });
  });

  test('live: an allowlisted message is sent through the provider', async () => {
    env.notifyAllowlist = ['+2348030000001'];
    const smsSpy = jest.spyOn(sms, 'send').mockResolvedValue('termii-123');
    const b = await book({ email: '' });
    await notifications.sendDue({ mode: 'live' });
    expect(smsSpy).toHaveBeenCalledWith({
      to: '+2348030000001',
      message: expect.stringContaining(b.reference),
    });
    expect((await rows(b.id))[0]).toMatchObject({ status: 'SENT', providerRef: 'termii-123' });
  });

  test('retries back off 1, 5, 30 minutes, then FAILED with a history entry; Resend re-queues', async () => {
    env.notifyAllowlist = ['+2348030000001'];
    jest.spyOn(sms, 'send').mockRejectedValue(new Error('Termii 500: down'));
    const b = await book({ email: '' });
    await prisma.notification.deleteMany({ where: { bookingId: b.id, channel: 'EMAIL' } });
    const t0 = new Date();
    const at = (min) => new Date(t0.getTime() + min * 60_000);
    const smsRow = async () => (await rows(b.id)).find((n) => n.channel === 'SMS');

    await notifications.sendDue({ mode: 'live', now: t0 });
    expect(await smsRow()).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      sendAfter: at(1),
      lastError: 'Termii 500: down',
    });
    // not due yet: nothing happens
    await notifications.sendDue({ mode: 'live', now: at(0.5) });
    expect((await smsRow()).attempts).toBe(1);
    await notifications.sendDue({ mode: 'live', now: at(1) });
    expect(await smsRow()).toMatchObject({ attempts: 2, sendAfter: at(6) });
    await notifications.sendDue({ mode: 'live', now: at(6) });
    expect(await smsRow()).toMatchObject({ attempts: 3, sendAfter: at(36) });
    await notifications.sendDue({ mode: 'live', now: at(36) });
    const failed = await smsRow();
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 4 });
    const ev = await prisma.bookingEvent.findFirst({
      where: { bookingId: b.id, type: 'NOTIFY_FAILED' },
    });
    expect(ev.note).toContain('failed after 4 attempts');
    expect(ev.note).not.toContain('8030000001'); // masked

    expect(await notifications.resend(failed.id)).toBe(true);
    expect(await smsRow()).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    expect(await notifications.resend(failed.id)).toBe(false); // only FAILED ones
  });
});

describe('admin', () => {
  test('the booking page lists messages and can resend a failed one', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const app = createApp({ sessionPool: pool });
    try {
      await prisma.$executeRawUnsafe('TRUNCATE "session", "Admin" RESTART IDENTITY');
      await prisma.admin.create({
        data: {
          email: 'o@test.ng',
          name: 'Ada',
          role: 'OWNER',
          passwordHash: await hashPassword('barbershop2026'),
        },
      });
      const b = await book();
      const [first] = await rows(b.id);
      await prisma.notification.update({
        where: { id: first.id },
        data: { status: 'FAILED', attempts: 4, lastError: 'Termii 500: down' },
      });

      const agent = request.agent(app);
      const page = await agent.get('/admin/login');
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)[1];
      await agent
        .post('/admin/login')
        .type('form')
        .send({ _csrf: csrf, email: 'o@test.ng', password: 'barbershop2026' })
        .expect(302);
      const html = (await agent.get(`/admin/bookings/${b.id}`)).text;
      expect(html).toContain('>Messages</h2>');
      expect(html).toContain('Booking confirmed');
      expect(html).toContain('Termii 500: down');
      expect(html).toContain(`/admin/notifications/${first.id}/resend`);
      const token = /name="csrf-token" content="([^"]+)"/.exec(html)[1];
      await agent
        .post(`/admin/notifications/${first.id}/resend`)
        .type('form')
        .send({ _csrf: token })
        .expect(303)
        .expect('Location', `/admin/bookings/${b.id}`);
      expect((await prisma.notification.findUnique({ where: { id: first.id } })).status).toBe(
        'PENDING',
      );
    } finally {
      await pool.end();
    }
  });
});
