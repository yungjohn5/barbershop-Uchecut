// Regression tests for the bug-fix round: settings Enter key, inactive barbers' bookings,
// zone caching, paused home visits, booking history, customer counts, 404 text, sign-in
// next=, and short calendar bookings.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');
const { hashPassword } = require('../../src/services/adminAuth');
const { createBooking, rescheduleBooking, cancelBooking } = require('../../src/services/booking');
const { homeVisitsOpen } = require('../../src/services/content');

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
      email: 'owner@test.ng',
      name: 'Ada',
      role: 'OWNER',
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
async function signIn() {
  const agent = request.agent(app);
  const page = await agent.get('/admin/login');
  await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrfOf(page.text), email: 'owner@test.ng', password: PASSWORD })
    .expect(302);
  const home = await agent.get('/admin').expect(200);
  return { agent, csrf: csrfOf(home.text) };
}
const DAY = (n) => addDays(toShopDate(new Date()), n);
const book = (o = {}) =>
  createBooking(
    {
      type: o.type || 'SHOP',
      serviceIds: o.serviceIds || [fx.cut.id],
      zoneId: o.type === 'HOME' ? fx.zone.id : null,
      barberId: o.barberId || fx.homeBarber.id,
      startsAt: wallClockToUtc(o.date || DAY(3), o.min ?? 660).toISOString(),
      customer: { name: o.name || 'Kemi Ade', phone: o.phone || '08030000001' },
      address: o.type === 'HOME' ? '1 Test Rd' : undefined,
    },
    { now: o.now },
  );

test('1. settings: Enter saves; “Restore defaults” lives in its own form', async () => {
  const { agent } = await signIn();
  const html = (await agent.get('/admin/settings').expect(200)).text;
  for (const section of ['booking', 'shop', 'home']) {
    // the section form's first submit button must be Save, not the reset button
    const form = html.split(`id="${section}" method="post"`)[1].split('</form>')[0];
    const firstSubmit = /<button type="submit"([^>]*)>/.exec(form)[1];
    expect(firstSubmit).toContain(`form="reset-${section}"`); // reset button is owned by the other form
    expect(html).toMatch(new RegExp(`<form id="reset-${section}"[^>]*hidden>`));
    // ...so the implicit (Enter) submitter is the Save button, which has no form= override
    expect(form).toMatch(/<button type="submit" class="btn-primary" data-a-submit>/);
  }
});

test('2. deactivating a barber with bookings warns, and their bookings stay on Today and Calendar', async () => {
  const today = await book({
    date: DAY(0),
    min: 1140,
    now: new Date(Date.now() - 6 * 3600_000),
  }).catch(() => null);
  const later = await book({ date: DAY(2) });
  const { agent, csrf } = await signIn();
  await agent
    .post(`/admin/barbers/${fx.homeBarber.id}`)
    .type('form')
    .send({ _csrf: csrf, name: 'Home Barber', serviceIds: [fx.cut.id] }) // "active" unticked
    .expect(303);
  const page = await agent.get(`/admin/barbers/${fx.homeBarber.id}`);
  expect(page.text).toContain('no longer taking new bookings');
  expect(page.text).toContain(later.reference);

  const cal = await agent
    .get(`/admin/calendar?date=${DAY(2)}&barber=${fx.homeBarber.id}`)
    .expect(200);
  expect(cal.text).toContain('(inactive)');
  expect(cal.text).toContain(`/admin/bookings/${later.id}`);
  if (today) {
    const dash = await agent.get('/admin').expect(200);
    expect(dash.text).toContain(today.customer.name);
    expect(dash.text).toContain('Inactive');
  }
});

test('3. /api/zones drops inactive zones immediately (revalidated, not cached)', async () => {
  await prisma.zone.create({
    data: { name: 'Ajah', feeKobo: 100000, travelBufferMin: 30, active: false },
  });
  const res = await request(app).get('/api/zones').expect(200);
  expect(res.headers['cache-control']).toBe('no-cache');
  expect(res.body.zones.map((z) => z.name)).toEqual(['Lekki']);
});

test('4. home visits are paused when no active barber can do them', async () => {
  expect(await homeVisitsOpen()).toBe(true);
  await prisma.barber.update({ where: { id: fx.homeBarber.id }, data: { doesHomeService: false } });
  expect(await homeVisitsOpen()).toBe(false);

  const home = await request(app).get('/').expect(200);
  expect(home.text).not.toContain('href="/book?type=HOME"');
  expect(home.text).toContain('Home visits are paused right now');

  const agent = request.agent(app);
  const step = await agent.get('/book?type=HOME').expect(200);
  expect(step.text).toMatch(/value="HOME"[^>]*disabled/);
  expect(step.text).toContain('Paused right now');
  await agent
    .post('/book/type')
    .type('form')
    .send({ _csrf: csrfOf(step.text), type: 'HOME', zoneId: fx.zone.id })
    .expect(302)
    .expect('Location', '/book');
  expect((await agent.get('/book')).text).toContain('Home visits are paused right now');
});

test('5. every change is recorded in the booking history, reschedules included', async () => {
  const b = await book({ type: 'HOME' });
  const { agent, csrf } = await signIn();
  await agent
    .post(`/admin/bookings/${b.id}/status`)
    .type('form')
    .send({ _csrf: csrf, action: 'confirm' })
    .expect(303);
  // customer moves it (home visit → needs confirming again), then staff move it back
  const t1 = wallClockToUtc(DAY(3), 780).toISOString();
  await rescheduleBooking(b.manageToken, { startsAt: t1, barberId: String(fx.homeBarber.id) });
  const page = await agent.get(
    `/admin/bookings/${b.id}/reschedule?date=${DAY(4)}&barber=${fx.homeBarber.id}`,
  );
  const t2 = /name="startsAt" value="([^"]+)"/.exec(page.text)[1];
  await agent
    .post(`/admin/bookings/${b.id}/reschedule`)
    .type('form')
    .send({ _csrf: csrf, startsAt: t2, barberId: String(fx.homeBarber.id) })
    .expect(303);

  const events = await prisma.bookingEvent.findMany({
    where: { bookingId: b.id },
    orderBy: { id: 'asc' },
  });
  expect(events.map((e) => [e.type, e.actor, e.byName])).toEqual([
    ['CREATED', 'CUSTOMER', null],
    ['CONFIRMED', 'STAFF', 'Ada'],
    ['RESCHEDULED', 'CUSTOMER', null],
    ['RESCHEDULED', 'STAFF', 'Ada'],
  ]);
  expect(events[2].data).toMatchObject({ from: b.startsAt.toISOString(), to: t1 });
  expect(events[2].note).toBe('Home visit needs confirming again');

  const detail = (await agent.get(`/admin/bookings/${b.id}`)).text;
  expect(detail).toContain('Booked online');
  expect(detail).toContain('Confirmed by Ada');
  expect(detail).toContain('Moved by customer');
  expect(detail).toContain('Moved by Ada');

  await cancelBooking(b.manageToken, { reason: 'Travelling' });
  const last = await prisma.bookingEvent.findFirst({
    where: { bookingId: b.id },
    orderBy: { id: 'desc' },
  });
  expect(last).toMatchObject({ type: 'CANCELLED', actor: 'CUSTOMER', note: 'Travelling' });
});

test('6 & 7. booking page splits upcoming and past, and counts bookings like the customer pages', async () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
  const past = await book({ date: DAY(-5), now: tenDaysAgo });
  const cancelled = await book({ date: DAY(2), min: 720 });
  await cancelBooking(cancelled.manageToken);
  const current = await book({ date: DAY(3) });
  const future = await book({ date: DAY(6) });

  const { agent } = await signIn();
  const html = (await agent.get(`/admin/bookings/${current.id}`)).text;
  const upcoming = html.split('>Upcoming</h2>')[1].split('</ul>')[0];
  const pastList = html.split('>Past visits</h2>')[1].split('</ul>')[0];
  expect(upcoming).toContain(`/admin/bookings/${future.id}`);
  expect(upcoming).not.toContain(`/admin/bookings/${past.id}`);
  expect(pastList).toContain(`/admin/bookings/${past.id}`);
  expect(pastList).not.toContain(`/admin/bookings/${future.id}`);

  // 4 bookings, 1 cancelled → 3 everywhere
  expect(html).toMatch(/>3 bookings</);
  const list = (await agent.get('/admin/customers')).text;
  expect(list).toMatch(/data-label="Bookings">\s*<span class="tabular-nums font-medium">3</);
  const profile = (await agent.get(`/admin/customers/${current.customerId}`)).text;
  expect(profile).toMatch(/a-stat-label">Bookings<\/p><p class="a-stat-value">3</);
});

test('8. 404 pages don’t reveal internal routes outside development', async () => {
  const res = await request(app).get('/admin-secret-thing').expect(404);
  expect(res.text).not.toContain('No route for');
  expect(res.text).toContain('This page doesn’t exist or may have moved.');
});

test('9. a failed sign-in keeps ?next=', async () => {
  const agent = request.agent(app);
  const login = await agent.get('/admin/settings').expect(302);
  expect(login.headers.location).toBe('/admin/login?next=%2Fadmin%2Fsettings');
  const page = await agent.get(login.headers.location);
  expect(page.text).toContain('action="/admin/login?next=%2Fadmin%2Fsettings"');
  const csrf = csrfOf(page.text);
  const failed = await agent
    .post('/admin/login?next=%2Fadmin%2Fsettings')
    .type('form')
    .send({
      _csrf: csrf,
      email: 'owner@test.ng',
      password: 'wrong-wrong-1',
      next: '/admin/settings',
    })
    .expect(401);
  expect(failed.text).toContain('value="/admin/settings"');
  expect(failed.text).toContain('action="/admin/login?next=%2Fadmin%2Fsettings"');
  // even if the hidden field were lost (e.g. a reload), the URL still carries it
  await agent
    .post('/admin/login?next=%2Fadmin%2Fsettings')
    .type('form')
    .send({ _csrf: csrf, email: 'owner@test.ng', password: PASSWORD })
    .expect(302)
    .expect('Location', '/admin/settings');
});

test('10. short bookings show the name on one line with a hover tooltip', async () => {
  const quick = await prisma.service.create({
    data: {
      name: 'Line-up',
      slug: 'line-up',
      priceKobo: 200000,
      durationMin: 15,
      categoryId: fx.cut.categoryId,
    },
  });
  await prisma.barberService.create({ data: { barberId: fx.homeBarber.id, serviceId: quick.id } });
  const b = await book({ serviceIds: [quick.id] });
  const { agent } = await signIn();
  const html = (await agent.get(`/admin/calendar?date=${DAY(3)}&barber=${fx.homeBarber.id}`)).text;
  const tag = html.split(`href="/admin/bookings/${b.id}"`)[1].split('>')[0];
  expect(tag).toContain('cal-short');
  expect(tag).toMatch(/title="11:00–11:15 · Kemi Ade\nLine-up"/);
});

describe('builder section and footer credit (Cyberninja Innovations)', () => {
  const URL =
    'https://cyberninjainnovations.com/?utm_source=verified-energy-auch&amp;utm_medium=referral&amp;utm_campaign=built-by';
  const WA =
    'https://wa.me/2349036257444?text=Hi%20Cyberninja%2C%20I%20saw%20the%20Verified%20Energy%20Auch%20website';
  const year = new Date().getFullYear();
  const saveShop = (agent, csrf, extra) =>
    agent
      .post('/admin/settings/shop')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Victory Barbershop',
        tagline: 'Sharp lines.',
        address: '1 Marina\nLagos',
        phone: '+2348031234567',
        whatsapp: '2348031234567',
        email: 'hi@victory.ng',
        hoursText: 'Mon–Sat 10–8',
        ...extra,
      })
      .expect(303);

  test('home page shows the section above the footer, with the agreed copy and links', async () => {
    const home = (await request(app).get('/').expect(200)).text;
    const section = home.split('id="built-by"')[1].split('</section>')[0];
    expect(home.indexOf('id="built-by"')).toBeLessThan(home.indexOf('<footer'));
    expect(section).toContain('Website &amp; booking system by');
    expect(section).toContain('Cyberninja <em class="accent">Innovations</em>');
    expect(section).toContain(
      'We build fast websites, booking systems and full-stack web apps for Nigerian businesses — from concept to deployment.',
    );
    for (const chip of [
      'Websites &amp; landing pages',
      'Booking &amp; e-commerce systems',
      'SaaS &amp; logistics platforms',
      'Technical consulting',
    ]) {
      expect(section).toContain(`</svg>${chip}</li>`);
    }
    expect(section.match(/<li class="builder-chip">/g)).toHaveLength(4);
    // the site preview and ticker are decoration only
    expect(section).toMatch(/<figure class="builder-showcase[^"]*" aria-hidden="true"/);
    expect(section).toContain('<div class="builder-ticker" aria-hidden="true">');
    expect(section).toContain(
      `<a href="${URL}" target="_blank" rel="noopener" class="btn-primary">Get a website like this`,
    );
    expect(section).toContain(
      `<a href="${WA}" target="_blank" rel="noopener" class="btn-ghost-light">Chat on WhatsApp</a>`,
    );
    // home page only
    expect((await request(app).get('/book').expect(200)).text).not.toContain('id="built-by"');
  });

  test('footer credit on every public page, year computed server-side', async () => {
    for (const url of ['/', '/book', '/does-not-exist']) {
      const html = (await request(app).get(url)).text;
      expect(html).toContain(
        `© ${year} Verified Energy Auch · Website by <a href="${URL}" target="_blank" rel="noopener"`,
      );
    }
    // not in the admin
    const { agent } = await signIn();
    expect((await agent.get('/admin')).text).not.toContain('Website by');
  });

  test('both can be switched off (and on) in Settings → Shop details', async () => {
    const { agent, csrf } = await signIn();
    const form = (await agent.get('/admin/settings')).text;
    expect(form).toMatch(/name="showBuilderSection"[^>]*checked/);
    expect(form).toMatch(/name="showBuilderCredit"[^>]*checked/);

    await saveShop(agent, csrf, {}); // both unticked
    let home = (await request(app).get('/')).text;
    expect(home).not.toContain('id="built-by"');
    expect(home).not.toContain('Website by');
    expect(home).toContain(`© ${year} Victory Barbershop</p>`);

    await saveShop(agent, csrf, { showBuilderSection: 'on' });
    home = (await request(app).get('/')).text;
    expect(home).toContain('id="built-by"');
    expect(home).not.toContain('Website by');

    await saveShop(agent, csrf, { showBuilderSection: 'on', showBuilderCredit: 'on' });
    expect((await request(app).get('/')).text).toContain('Website by');
  });

  test('the footer follows the shop name from Settings', async () => {
    const { agent, csrf } = await signIn();
    await saveShop(agent, csrf, {
      name: 'Uche Cuts',
      showBuilderSection: 'on',
      showBuilderCredit: 'on',
    });
    expect((await request(app).get('/')).text).toContain(`© ${year} Uche Cuts · Website by`);
  });
});
