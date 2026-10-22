// Admin dashboard over HTTP: sign-in and lockout, route guards, status actions,
// staff bookings, reschedule, calendar and the admin JSON endpoints.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');
const { authenticate, hashPassword, MAX_FAILED } = require('../../src/services/adminAuth');
const { createBooking } = require('../../src/services/booking');
const adminBookings = require('../../src/services/adminBookings');

const EMAIL = 'owner@test.ng';
const PASSWORD = 'barbershop2026';

let app;
let pool;
let fx;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE "session", "Admin" RESTART IDENTITY');
  fx = await seedFixtures();
  await prisma.admin.create({
    data: {
      email: EMAIL,
      name: 'Ada Owner',
      role: 'OWNER',
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const DATE = () => addDays(toShopDate(new Date()), 3);
const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];

async function signIn() {
  const agent = request.agent(app);
  const page = await agent.get('/admin/login').expect(200);
  const csrf = csrfOf(page.text);
  await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrf, email: EMAIL, password: PASSWORD, next: '/admin/bookings' })
    .expect(302)
    .expect('Location', '/admin/bookings');
  const home = await agent.get('/admin').expect(200);
  return { agent, csrf: csrfOf(home.text) };
}

function book({
  type = 'SHOP',
  date = DATE(),
  min = 660,
  phone = '08030000001',
  actor = 'customer',
} = {}) {
  return createBooking(
    {
      type,
      serviceIds: [fx.cut.id],
      zoneId: type === 'HOME' ? fx.zone.id : null,
      barberId: fx.homeBarber.id,
      startsAt: wallClockToUtc(date, min).toISOString(),
      customer: { name: 'Kemi Ade', phone },
      address: type === 'HOME' ? '4 Admiralty Way' : undefined,
    },
    { actor },
  );
}

describe('authenticate', () => {
  test('locks the account after repeated wrong passwords, even for the right one', async () => {
    for (let i = 0; i < MAX_FAILED - 1; i++) {
      expect((await authenticate(EMAIL, 'wrong-password')).reason).toMatch(/don’t match/);
    }
    expect((await authenticate(EMAIL, 'wrong-password')).reason).toMatch(/Too many attempts/);
    const locked = await authenticate(EMAIL, PASSWORD);
    expect(locked.ok).toBe(false);
    expect(locked.reason).toMatch(/Try again in 15 minutes/);
    // ...and works again once the lock has passed
    const later = await authenticate(EMAIL, PASSWORD, { now: new Date(Date.now() + 16 * 60_000) });
    expect(later.ok).toBe(true);
  });

  test('unknown emails and deactivated accounts get the generic message', async () => {
    expect((await authenticate('nobody@test.ng', PASSWORD)).reason).toMatch(/don’t match/);
    await prisma.admin.update({ where: { email: EMAIL }, data: { active: false } });
    expect((await authenticate(EMAIL, PASSWORD)).ok).toBe(false);
  });

  test('email is matched case-insensitively', async () => {
    expect((await authenticate('  OWNER@test.ng ', PASSWORD)).ok).toBe(true);
  });
});

describe('admin routes', () => {
  test('signed-out visitors are sent to the login page; the API answers 401', async () => {
    await request(app)
      .get('/admin/bookings')
      .expect(302)
      .expect('Location', '/admin/login?next=%2Fadmin%2Fbookings');
    await request(app).get('/admin/api/slots').expect(401);
  });

  test('login needs a CSRF token and rejects a wrong password with 401', async () => {
    await request(app)
      .post('/admin/login')
      .type('form')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(403);
    const agent = request.agent(app);
    const page = await agent.get('/admin/login');
    const res = await agent
      .post('/admin/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), email: EMAIL, password: 'nope-nope-nope' })
      .expect(401);
    expect(res.text).toMatch(/don’t match/);
  });

  test('a signed-in admin sees Today, bookings, detail and calendar', async () => {
    const { agent } = await signIn();
    const b = await book();
    expect((await agent.get('/admin').expect(200)).text).toMatch(/Ada/);
    const list = await agent.get('/admin/bookings?scope=all').expect(200);
    expect(list.text).toContain(b.reference);
    const search = await agent.get('/admin/bookings?scope=all&q=kemi').expect(200);
    expect(search.text).toContain(b.reference);
    const miss = await agent.get('/admin/bookings?scope=all&q=zzz').expect(200);
    expect(miss.text).not.toContain(b.reference);
    const detail = await agent.get(`/admin/bookings/${b.id}`).expect(200);
    expect(detail.text).toContain('Kemi Ade');
    expect(detail.text).toContain(`/manage/${b.manageToken}`);
    const cal = await agent
      .get(`/admin/calendar?date=${DATE()}&barber=${fx.homeBarber.id}`)
      .expect(200);
    expect(cal.text).toContain(`/admin/bookings/${b.id}`);
    await agent.get('/admin/bookings/99999').expect(404);
  });

  test('sign out ends the session', async () => {
    const { agent, csrf } = await signIn();
    await agent.post('/admin/logout').type('form').send({ _csrf: csrf }).expect(302);
    await agent.get('/admin').expect(302);
  });
});

describe('status actions', () => {
  test('confirm a pending home visit; actions not allowed are refused', async () => {
    const { agent, csrf } = await signIn();
    const b = await book({ type: 'HOME' });
    expect(b.status).toBe('PENDING');
    await agent
      .post(`/admin/bookings/${b.id}/status`)
      .type('form')
      .send({ _csrf: csrf, action: 'complete' })
      .expect(303);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe('PENDING');
    await agent
      .post(`/admin/bookings/${b.id}/status`)
      .type('form')
      .send({ _csrf: csrf, action: 'confirm' })
      .expect(303);
    const after = await prisma.booking.findUnique({ where: { id: b.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.confirmedAt).not.toBeNull();
  });

  test('no-show counts against the customer and undo restores it', async () => {
    const b = await book();
    const later = new Date(b.startsAt.getTime() + 60 * 60_000);
    await adminBookings.applyAction(b.id, 'noShow', { now: later });
    expect((await prisma.customer.findUnique({ where: { id: b.customerId } })).noShowCount).toBe(1);
    await adminBookings.applyAction(b.id, 'undo', { now: later });
    expect((await prisma.customer.findUnique({ where: { id: b.customerId } })).noShowCount).toBe(0);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe('CONFIRMED');
  });

  test('cancelling frees the slot and keeps the reason', async () => {
    const { agent, csrf } = await signIn();
    const b = await book();
    await agent
      .post(`/admin/bookings/${b.id}/status`)
      .type('form')
      .send({ _csrf: csrf, action: 'cancel', reason: 'Customer called' })
      .expect(303);
    const after = await prisma.booking.findUnique({ where: { id: b.id } });
    expect(after).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer called' });
    await expect(book({ phone: '08030000009' })).resolves.toBeTruthy();
  });

  test('staff notes are saved', async () => {
    const { agent, csrf } = await signIn();
    const b = await book();
    await agent
      .post(`/admin/bookings/${b.id}/notes`)
      .type('form')
      .send({ _csrf: csrf, staffNotes: 'Prefers scissors' })
      .expect(303);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).staffNotes).toBe(
      'Prefers scissors',
    );
  });
});

describe('staff bookings', () => {
  test('staff home visits are confirmed straight away and marked STAFF', async () => {
    const { agent, csrf } = await signIn();
    const slots = await agent
      .get(
        `/admin/api/slots?date=${DATE()}&barber=any&services=${fx.cut.id}&type=HOME&zone=${fx.zone.id}`,
      )
      .expect(200);
    const startsAt = slots.body.slots[0].startsAt;
    const res = await agent
      .post('/admin/bookings')
      .type('form')
      .send({
        _csrf: csrf,
        type: 'HOME',
        zoneId: fx.zone.id,
        serviceIds: [fx.cut.id],
        barberId: 'any',
        startsAt,
        name: 'Walk In',
        phone: '0803 000 0005',
        address: '1 Ozumba Mbadiwe',
      })
      .expect(303);
    const b = await prisma.booking.findFirst({ where: { customer: { name: 'Walk In' } } });
    expect(res.headers.location).toBe(`/admin/bookings/${b.id}`);
    expect(b).toMatchObject({ status: 'CONFIRMED', source: 'STAFF', type: 'HOME' });
  });

  test('missing details come back as errors on the form (PRG)', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/bookings')
      .type('form')
      .send({ _csrf: csrf, type: 'SHOP' })
      .expect(303)
      .expect('Location', '/admin/bookings/new');
    const form = await agent.get('/admin/bookings/new').expect(200);
    expect(form.text).toMatch(/Choose at least one service/);
    expect(form.text).toMatch(/Phone number is required/);
  });

  test('staff slots ignore the customer lead time', async () => {
    const { agent } = await signIn();
    const today = toShopDate(new Date());
    const staff = await agent
      .get(`/admin/api/slots?date=${today}&barber=any&services=${fx.cut.id}&type=SHOP`)
      .expect(200);
    const customer = await request(app).get(
      `/api/slots?date=${today}&barber=any&services=${fx.cut.id}&type=SHOP`,
    );
    const count = (r) => (r.body.slots || []).length;
    expect(count(staff)).toBeGreaterThanOrEqual(count(customer));
  });

  test('phone lookup finds returning customers', async () => {
    const { agent } = await signIn();
    await book({ phone: '08030000001' });
    const hit = await agent.get('/admin/api/customer?phone=0803%20000%200001').expect(200);
    expect(hit.body.customer).toMatchObject({ name: 'Kemi Ade', noShowCount: 0 });
    expect(hit.body.customer._count.bookings).toBe(1);
    const miss = await agent.get('/admin/api/customer?phone=08039999999').expect(200);
    expect(miss.body.customer).toBeNull();
  });

  test('staff can move a booking to another free time', async () => {
    const { agent, csrf } = await signIn();
    const b = await book();
    const page = await agent
      .get(`/admin/bookings/${b.id}/reschedule?date=${DATE()}&barber=${fx.homeBarber.id}`)
      .expect(200);
    const slots = [...page.text.matchAll(/name="startsAt" value="([^"]+)"/g)].map((m) => m[1]);
    const target = slots.find((s) => s !== b.startsAt.toISOString());
    await agent
      .post(`/admin/bookings/${b.id}/reschedule`)
      .type('form')
      .send({ _csrf: csrf, startsAt: target, barberId: String(fx.homeBarber.id) })
      .expect(303)
      .expect('Location', `/admin/bookings/${b.id}`);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).startsAt.toISOString()).toBe(
      target,
    );
  });
});

describe('weekCalendar', () => {
  test('places bookings with their travel buffers on the right day', async () => {
    const b = await book({ type: 'HOME', min: 720 });
    const cal = await adminBookings.weekCalendar({ date: DATE(), barberId: fx.homeBarber.id });
    const day = cal.days.find((d) => d.date === DATE());
    expect(day.events).toHaveLength(1);
    expect(day.events[0]).toMatchObject({ from: 720, to: 750, blockFrom: 690, blockTo: 780 });
    expect(day.events[0].booking.id).toBe(b.id);
    expect(cal.days).toHaveLength(7);
    expect(cal.axis.from).toBeLessThanOrEqual(600);
  });
});
