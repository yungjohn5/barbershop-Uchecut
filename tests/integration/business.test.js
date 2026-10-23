// Customers, reports, settings, users and "your account" over HTTP.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');
const { hashPassword } = require('../../src/services/adminAuth');
const { createBooking } = require('../../src/services/booking');
const adminBookings = require('../../src/services/adminBookings');

const PASSWORD = 'barbershop2026';
let app;
let pool;
let fx;
let owner;
let staff;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE "session", "Admin" RESTART IDENTITY');
  fx = await seedFixtures();
  const passwordHash = await hashPassword(PASSWORD);
  owner = await prisma.admin.create({
    data: { email: 'owner@test.ng', name: 'Ada', role: 'OWNER', passwordHash },
  });
  staff = await prisma.admin.create({
    data: { email: 'staff@test.ng', name: 'Sam', role: 'STAFF', passwordHash },
  });
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
async function signIn(email = 'owner@test.ng', password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/admin/login');
  await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrfOf(page.text), email, password })
    .expect(302);
  const home = await agent.get('/admin').expect(200);
  return { agent, csrf: csrfOf(home.text) };
}
const book = (phone, name, dayOffset = 3, min = 660) =>
  createBooking({
    type: 'SHOP',
    serviceIds: [fx.cut.id],
    barberId: fx.homeBarber.id,
    startsAt: wallClockToUtc(addDays(toShopDate(new Date()), dayOffset), min).toISOString(),
    customer: { name, phone },
  });

describe('customers', () => {
  test('staff can search, open and annotate customers', async () => {
    await book('08030000001', 'Kemi Ade');
    const b2 = await book('08030000002', 'Tobi Lawal', 4);
    const { agent, csrf } = await signIn('staff@test.ng');

    const all = await agent.get('/admin/customers').expect(200);
    expect(all.text).toContain('Kemi Ade');
    expect(all.text).toContain('Tobi Lawal');
    for (const sort of ['recent', 'visits', 'spent', 'noshows', 'name', 'newest']) {
      await agent.get(`/admin/customers?sort=${sort}`).expect(200);
    }
    // Both bookings are upcoming: shown as "Next", never as a past "last visit".
    expect(all.text.match(/Next · /g)).toHaveLength(2);
    expect(all.text).not.toMatch(/data-label="Last visit">[A-Z][a-z]{2} \d/);

    const byPhone = await agent.get('/admin/customers?q=0803%20000%200002').expect(200);
    expect(byPhone.text).toContain('Tobi Lawal');
    expect(byPhone.text).not.toContain('Kemi Ade');

    const page = await agent.get(`/admin/customers/${b2.customerId}`).expect(200);
    expect(page.text).toContain(b2.reference);
    expect(page.text).toContain('/admin/bookings/new?phone=');

    await agent
      .post(`/admin/customers/${b2.customerId}`)
      .type('form')
      .send({ _csrf: csrf, name: 'Tobi Lawal', email: 'Tobi@Mail.com', notes: 'Likes a low fade' })
      .expect(303);
    expect(await prisma.customer.findUnique({ where: { id: b2.customerId } })).toMatchObject({
      email: 'tobi@mail.com',
      notes: 'Likes a low fade',
    });

    await agent
      .post(`/admin/customers/${b2.customerId}`)
      .type('form')
      .send({ _csrf: csrf, name: 'T', email: 'nope' })
      .expect(303);
    expect((await agent.get(`/admin/customers/${b2.customerId}`)).text).toMatch(
      /Enter a valid email/,
    );
  });

  test('“Book them in” prefills the staff form', async () => {
    const { agent } = await signIn();
    const res = await agent
      .get('/admin/bookings/new?phone=%2B2348030000001&name=Kemi%20Ade')
      .expect(200);
    expect(res.text).toContain('value="+2348030000001"');
    expect(res.text).toContain('value="Kemi Ade"');
  });
});

describe('owner-only business pages', () => {
  test('staff are refused reports, settings and users but can use their account page', async () => {
    const { agent, csrf } = await signIn('staff@test.ng');
    for (const url of ['/admin/reports', '/admin/settings', '/admin/users'])
      await agent.get(url).expect(403);
    await agent
      .post('/admin/settings/shop')
      .type('form')
      .send({ _csrf: csrf, name: 'Hacked' })
      .expect(403);
    await agent.get('/admin/account').expect(200);
  });
});

describe('reports', () => {
  test('counts this month’s bookings and takings', async () => {
    const date = addDays(toShopDate(new Date()), 3);
    const a = await book('08030000001', 'Kemi Ade', 3, 660);
    await book('08030000002', 'Tobi Lawal', 3, 720);
    await adminBookings.applyAction(a.id, 'complete', {
      now: new Date(a.startsAt.getTime() + 60_000),
    });
    const { agent } = await signIn();
    const res = await agent.get(`/admin/reports?from=${date}&to=${date}`).expect(200);
    expect(res.text).toContain('Custom range');
    expect(res.text).not.toContain('No bookings in this period');
    expect(res.text).toContain('₦15,000'); // booked: two cuts
    expect(res.text).toContain('₦7,500'); // taken: one
    expect(res.text).toContain('Home Barber');
  });
});

describe('settings', () => {
  test('shop details show on the public site straight away', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/settings/shop')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Uche Cuts',
        tagline: 'Clean lines.',
        address: '1 Marina\nLagos',
        phone: '+2348031234567',
        whatsapp: '2348031234567',
        email: 'hi@uche.ng',
        hoursText: 'Mon–Sat 10–8',
        instagram: 'https://instagram.com/uche',
      })
      .expect(303)
      .expect('Location', '/admin/settings#shop');
    const home = await request(app).get('/').expect(200);
    expect(home.text).toContain('Uche Cuts');
    expect(home.text).toContain('https://instagram.com/uche');
  });

  test('booking rules change what customers can book; restore defaults undoes it', async () => {
    const { agent, csrf } = await signIn();
    const far = addDays(toShopDate(new Date()), 20);
    const slots = () =>
      request(app).get(`/api/slots?date=${far}&barber=any&services=${fx.cut.id}&type=SHOP`);
    expect((await slots()).body.slots.length).toBeGreaterThan(0);

    await agent
      .post('/admin/settings/booking')
      .type('form')
      .send({
        _csrf: csrf,
        leadTimeShopMin: '2',
        leadTimeHomeMin: '24',
        cancelCutoffMin: '3',
        homeAutoCancelHours: '12',
        bookingWindowDays: '7',
        slotStepMin: '30',
      })
      .expect(303);
    expect((await prisma.setting.findUnique({ where: { key: 'bookingWindowDays' } })).value).toBe(
      7,
    );
    const after = await slots();
    expect(after.body.slots || []).toHaveLength(0);

    await agent
      .post('/admin/settings/booking')
      .type('form')
      .send({ _csrf: csrf, reset: '1' })
      .expect(303);
    expect(await prisma.setting.findUnique({ where: { key: 'bookingWindowDays' } })).toBeNull();
    expect((await slots()).body.slots.length).toBeGreaterThan(0);
  });

  test('invalid copy is refused and nothing is saved', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/settings/home')
      .type('form')
      .send({ _csrf: csrf, heroLines: 'Only one line' })
      .expect(303);
    expect(await prisma.setting.findUnique({ where: { key: 'home' } })).toBeNull();
    expect((await agent.get('/admin/settings')).text).toMatch(/at least 3 hero lines/);
  });
});

describe('users', () => {
  test('create an account; duplicates and weak passwords are refused; passwords never stored in the session', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/users')
      .type('form')
      .send({ _csrf: csrf, name: 'Bayo', email: 'Bayo@Test.ng', role: 'STAFF', password: 'short1' })
      .expect(303);
    expect(await prisma.admin.findUnique({ where: { email: 'bayo@test.ng' } })).toBeNull();
    const sessions = await prisma.$queryRaw`SELECT sess::text AS s FROM "session"`;
    expect(sessions.some((r) => r.s.includes('short1'))).toBe(false);

    await agent
      .post('/admin/users')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Bayo',
        email: 'Bayo@Test.ng',
        role: 'STAFF',
        password: 'clippers2026x',
      })
      .expect(303);
    expect(await prisma.admin.findUnique({ where: { email: 'bayo@test.ng' } })).toMatchObject({
      role: 'STAFF',
      active: true,
    });
    await agent
      .post('/admin/users')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Bayo 2',
        email: 'bayo@test.ng',
        role: 'STAFF',
        password: 'clippers2026x',
      })
      .expect(303);
    expect(await prisma.admin.count({ where: { email: 'bayo@test.ng' } })).toBe(1);
    await signIn('bayo@test.ng', 'clippers2026x');
  });

  test('deactivating signs the person out at once', async () => {
    const staffSession = await signIn('staff@test.ng');
    const { agent, csrf } = await signIn();
    await agent
      .post(`/admin/users/${staff.id}/active`)
      .type('form')
      .send({ _csrf: csrf, active: 'false' })
      .expect(303);
    await staffSession.agent.get('/admin').expect(302);
    const page = await request(app).get('/admin/login');
    await request(app)
      .post('/admin/login')
      .type('form')
      .send({ _csrf: csrfOf(page.text), email: 'staff@test.ng', password: PASSWORD });
    expect((await prisma.admin.findUnique({ where: { id: staff.id } })).active).toBe(false);
  });

  test('there is always an active owner, and you can’t lock yourself out', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post(`/admin/users/${owner.id}/active`)
      .type('form')
      .send({ _csrf: csrf, active: 'false' })
      .expect(303);
    await agent
      .post(`/admin/users/${owner.id}`)
      .type('form')
      .send({ _csrf: csrf, name: 'Ada', role: 'STAFF' })
      .expect(303);
    expect(await prisma.admin.findUnique({ where: { id: owner.id } })).toMatchObject({
      active: true,
      role: 'OWNER',
    });
    // Promote staff, then the first owner may be demoted by the other.
    await agent
      .post(`/admin/users/${staff.id}`)
      .type('form')
      .send({ _csrf: csrf, name: 'Sam', role: 'OWNER' })
      .expect(303);
    expect((await prisma.admin.findUnique({ where: { id: staff.id } })).role).toBe('OWNER');
  });

  test('resetting a password signs them out and clears a lockout', async () => {
    const staffSession = await signIn('staff@test.ng');
    await prisma.admin.update({
      where: { id: staff.id },
      data: { lockedUntil: new Date(Date.now() + 600_000) },
    });
    const { agent, csrf } = await signIn();
    await agent
      .post(`/admin/users/${staff.id}/password`)
      .type('form')
      .send({ _csrf: csrf, password: 'freshstart2026' })
      .expect(303);
    await staffSession.agent.get('/admin').expect(302);
    expect((await prisma.admin.findUnique({ where: { id: staff.id } })).lockedUntil).toBeNull();
    await signIn('staff@test.ng', 'freshstart2026');
  });
});

describe('your account', () => {
  test('change your password: other devices are signed out, this one stays', async () => {
    const other = await signIn('staff@test.ng');
    const { agent, csrf } = await signIn('staff@test.ng');
    await agent
      .post('/admin/account/password')
      .type('form')
      .send({
        _csrf: csrf,
        current: 'wrong-one-123',
        password: 'newpassword2026',
        confirm: 'newpassword2026',
      })
      .expect(303);
    expect((await agent.get('/admin/account')).text).toMatch(/That isn’t your current password/);

    await agent
      .post('/admin/account/password')
      .type('form')
      .send({
        _csrf: csrf,
        current: PASSWORD,
        password: 'newpassword2026',
        confirm: 'newpassword2026',
      })
      .expect(303);
    await agent.get('/admin').expect(200);
    await other.agent.get('/admin').expect(302);
    await signIn('staff@test.ng', 'newpassword2026');
  });
});
