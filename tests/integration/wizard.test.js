// End-to-end booking flow over HTTP: session draft, CSRF, step guards, confirmation,
// manage link (calendar, reschedule, cancel) and the "slot just taken" path.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const { addDays, toShopDate } = require('../../src/lib/time');

let app;
let pool;
let fx;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE "session"');
  fx = await seedFixtures();
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const DATE = () => addDays(toShopDate(new Date()), 3); // fixture barbers work daily 10:00–20:00
const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
const slotsOf = (html) => [...html.matchAll(/name="startsAt" value="([^"]+)"/g)].map((m) => m[1]);

async function startAgent() {
  const agent = request.agent(app);
  const res = await agent.get('/book').expect(200);
  return { agent, csrf: csrfOf(res.text) };
}

async function walkToDetails({ type = 'SHOP', serviceIds, zoneId } = {}) {
  const { agent, csrf } = await startAgent();
  await agent
    .post('/book/type')
    .type('form')
    .send({ _csrf: csrf, type, ...(zoneId ? { zoneId } : {}) })
    .expect(302)
    .expect('Location', '/book/services');
  await agent
    .post('/book/services')
    .type('form')
    .send({ _csrf: csrf, serviceIds: serviceIds || [fx.cut.id] })
    .expect(302)
    .expect('Location', '/book/time');
  const time = await agent.get(`/book/time?date=${DATE()}`).expect(200);
  const slot = slotsOf(time.text)[0];
  expect(slot).toBeDefined();
  await agent
    .post('/book/time')
    .type('form')
    .send({ _csrf: csrf, startsAt: slot, barberId: 'any' })
    .expect(302)
    .expect('Location', '/book/details');
  return { agent, csrf, slot };
}

describe('booking wizard', () => {
  test('steps are guarded: later steps redirect to the first incomplete one', async () => {
    const agent = request.agent(app);
    await agent.get('/book/details').expect(302).expect('Location', '/book');
    await agent.get('/book/time').expect(302).expect('Location', '/book');
  });

  test('POST without a CSRF token is rejected', async () => {
    await request(app).post('/book/type').type('form').send({ type: 'SHOP' }).expect(403);
  });

  test('deep links prefill the chosen service', async () => {
    const agent = request.agent(app);
    await agent.get(`/book?type=SHOP&service=${fx.shave.id}`).expect(200);
    const res = await agent.get('/book/services').expect(200);
    expect(res.text).toMatch(new RegExp(`value="${fx.shave.id}"[^>]*checked`));
  });

  test('shop booking: full flow → confirmation → manage → calendar → reschedule → cancel', async () => {
    const { agent, csrf, slot } = await walkToDetails();

    const done = await agent
      .post('/book')
      .type('form')
      .send({ _csrf: csrf, name: 'Ada Obi', phone: '0803 123 4567', email: 'ada@example.com' })
      .expect(302);
    const ref = /\/book\/confirmed\/(VB-[A-Z2-9]{5})$/.exec(done.headers.location)[1];

    const confirmed = await agent.get(`/book/confirmed/${ref}`).expect(200);
    expect(confirmed.text).toContain('You’re booked.');
    expect(confirmed.text).toContain(ref);
    expect(confirmed.text).toMatch(
      /We’ve emailed your confirmation to <strong[^>]*>ada@example\.com</,
    );
    // the confirmation is private to the booking session
    await request(app).get(`/book/confirmed/${ref}`).expect(404);

    const booking = await prisma.booking.findUnique({ where: { reference: ref } });
    expect(booking).toMatchObject({ status: 'CONFIRMED', type: 'SHOP', totalKobo: 750000 });
    expect(booking.startsAt.toISOString()).toBe(slot);
    const token = booking.manageToken;
    expect(confirmed.text).toContain(`/manage/${token}`);

    const manage = await request(app).get(`/manage/${token}`).expect(200);
    expect(manage.text).toContain('Confirmed');
    expect(manage.text).toContain('Reschedule');

    const ics = await request(app).get(`/manage/${token}/calendar.ics`).expect(200);
    expect(ics.headers['content-type']).toMatch(/text\/calendar/);
    expect(ics.text).toContain('BEGIN:VEVENT');
    expect(ics.text).toContain(ref);

    // reschedule to a different free time (manage pages are their own session)
    const m = request.agent(app);
    const page = await m.get(`/manage/${token}/reschedule?date=${addDays(DATE(), 1)}`).expect(200);
    const target = slotsOf(page.text)[2];
    const json = await m.get(`/manage/${token}/slots?date=${addDays(DATE(), 1)}`).expect(200);
    expect(json.body.slots.map((s) => s.startsAt)).toContain(target);
    await m
      .post(`/manage/${token}/reschedule`)
      .type('form')
      .send({ _csrf: csrfOf(page.text), startsAt: target, barberId: 'any' })
      .expect(302)
      .expect('Location', `/manage/${token}`);
    const moved = await prisma.booking.findUnique({ where: { reference: ref } });
    expect(moved.startsAt.toISOString()).toBe(target);
    expect(moved.status).toBe('CONFIRMED');

    // cancel
    const again = await m.get(`/manage/${token}`).expect(200);
    await m
      .post(`/manage/${token}/cancel`)
      .type('form')
      .send({ _csrf: csrfOf(again.text), reason: 'Travelling' })
      .expect(302);
    const cancelled = await prisma.booking.findUnique({ where: { reference: ref } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Travelling' });
    const after = await m.get(`/manage/${token}`).expect(200);
    expect(after.text).toContain('This booking has been cancelled.');
    expect(after.text).not.toContain('>Reschedule');
  });

  test('home visit: zone required, shop-only services hidden, address validated, ends PENDING', async () => {
    const { agent, csrf } = await startAgent();
    await agent
      .post('/book/type')
      .type('form')
      .send({ _csrf: csrf, type: 'HOME' })
      .expect(302)
      .expect('Location', '/book');

    const ctx = await walkToDetails({ type: 'HOME', zoneId: fx.zone.id });
    const services = await ctx.agent.get('/book/services').expect(200);
    expect(services.text).toContain('Cut');
    expect(services.text).not.toMatch(/value="\d+"[^>]*data-name="Shave"/);

    // Post/Redirect/Get: errors come back on a GET, so a refresh never resubmits.
    await ctx.agent
      .post('/book')
      .type('form')
      .send({ _csrf: ctx.csrf, name: 'Ada Obi', phone: '08031234567' })
      .expect(303)
      .expect('Location', '/book/details');
    const missing = await ctx.agent.get('/book/details').expect(200);
    expect(missing.text).toContain('Please enter the address for the visit.');
    expect(missing.text).toContain('value="Ada Obi"'); // keeps what was typed
    const refreshed = await ctx.agent.get('/book/details').expect(200);
    expect(refreshed.text).not.toContain('Please enter the address for the visit.'); // shown once
    expect(refreshed.text).toContain('value="Ada Obi"');

    const ok = await ctx.agent
      .post('/book')
      .type('form')
      .send({
        _csrf: ctx.csrf,
        name: 'Ada Obi',
        phone: '08031234567',
        address: '12 Admiralty Way, Lekki',
      })
      .expect(302);
    const ref = ok.headers.location.split('/').pop();
    const page = await ctx.agent.get(`/book/confirmed/${ref}`).expect(200);
    expect(page.text).toContain('We’ve got your request.');
    expect(await prisma.booking.findUnique({ where: { reference: ref } })).toMatchObject({
      status: 'PENDING',
      homeFeeKobo: 300000,
      totalKobo: 1050000,
    });
  });

  test('if the slot is taken before submitting, the customer is sent back to pick again', async () => {
    const { agent, csrf, slot } = await walkToDetails();
    // someone else books every barber at that time first
    for (const b of [fx.homeBarber, fx.shopBarber]) {
      const c = await prisma.customer.create({
        data: { name: 'X', phone: `+23480300000${b.id}0` },
      });
      await prisma.booking.create({
        data: {
          reference: `VB-TAKE${b.id}`,
          manageToken: `t${b.id}`.padEnd(43, 'x'),
          type: 'SHOP',
          status: 'CONFIRMED',
          startsAt: new Date(slot),
          endsAt: new Date(new Date(slot).getTime() + 30 * 60000),
          blockStartsAt: new Date(slot),
          blockEndsAt: new Date(new Date(slot).getTime() + 30 * 60000),
          subtotalKobo: 0,
          totalKobo: 0,
          barberId: b.id,
          customerId: c.id,
        },
      });
    }
    const res = await agent
      .post('/book')
      .type('form')
      .send({ _csrf: csrf, name: 'Ada Obi', phone: '08031234567' })
      .expect(302);
    expect(res.headers.location).toMatch(/^\/book\/time\?date=/);
    const back = await agent.get(res.headers.location).expect(200);
    expect(back.text).toContain('that time was just taken');
    expect(slotsOf(back.text)).not.toContain(slot);
  });

  test('unknown manage tokens are a 404', async () => {
    await request(app).get('/manage/not-a-real-token').expect(404);
    await request(app)
      .get(`/manage/${'a'.repeat(43)}`)
      .expect(404);
  });
});

describe('booking polish', () => {
  test('a typed but invalid phone gets the "valid Nigerian mobile" message', async () => {
    const { agent, csrf } = await walkToDetails();
    await agent
      .post('/book')
      .type('form')
      .send({ _csrf: csrf, name: 'Ada Obi', phone: '12345' })
      .expect(303);
    const page = await agent.get('/book/details').expect(200);
    expect(page.text).toContain('Enter a valid Nigerian mobile, e.g. 0803 123 4567.');
    expect(page.text).not.toContain('Please enter your phone number.');

    await agent
      .post('/book')
      .type('form')
      .send({ _csrf: csrf, name: 'Ada Obi', phone: '' })
      .expect(303);
    expect((await agent.get('/book/details')).text).toContain('Please enter your phone number.');
  });

  test('home visits open on the first date with free times, not today', async () => {
    const { agent, csrf } = await startAgent();
    await agent
      .post('/book/type')
      .type('form')
      .send({ _csrf: csrf, type: 'HOME', zoneId: fx.zone.id });
    await agent
      .post('/book/services')
      .type('form')
      .send({ _csrf: csrf, serviceIds: [fx.cut.id] });
    const page = await agent.get('/book/time').expect(200);
    const today = toShopDate(new Date());
    expect(page.text).not.toMatch(new RegExp(`data-date="${today}"`));
    expect(slotsOf(page.text).length).toBeGreaterThan(0);
  });

  test('empty day: "Any barber" hint only when a specific barber is selected', async () => {
    const { agent, csrf } = await startAgent();
    await agent
      .post('/book/type')
      .type('form')
      .send({ _csrf: csrf, type: 'HOME', zoneId: fx.zone.id });
    await agent
      .post('/book/services')
      .type('form')
      .send({ _csrf: csrf, serviceIds: [fx.cut.id] });
    const today = toShopDate(new Date()); // never bookable for a home visit (24 h lead time)
    const any = await agent.get(`/book/time?date=${today}&barber=any`).expect(200);
    expect(any.text).toContain('No free times on this day.');
    expect(any.text).not.toContain('choose “Any barber”');
    const one = await agent.get(`/book/time?date=${today}&barber=${fx.homeBarber.id}`).expect(200);
    expect(one.text).toContain('choose “Any barber”');
  });

  test('step 1 shows the travel fee once an area is picked; areas have accessible names', async () => {
    const { agent, csrf } = await startAgent();
    await agent
      .post('/book/type')
      .type('form')
      .send({ _csrf: csrf, type: 'HOME', zoneId: fx.zone.id });
    const page = await agent.get('/book').expect(200);
    expect(page.text).toMatch(/data-sum-total>\+₦3,000 <span[^>]*>travel<\/span>/);
    expect(page.text).toContain(`aria-labelledby="zone-${fx.zone.id}-name"`);
    expect(page.text).toContain(`id="zone-${fx.zone.id}-name">Lekki</span>`);
  });

  test('confirmation shows "Landmark: …" and a formatted phone number', async () => {
    const ctx = await walkToDetails({ type: 'HOME', zoneId: fx.zone.id });
    const res = await ctx.agent
      .post('/book')
      .type('form')
      .send({
        _csrf: ctx.csrf,
        name: 'Ada Obi',
        phone: '08031234567',
        address: '12 Admiralty Way',
        landmark: 'Near the filling station',
      })
      .expect(302);
    const page = await ctx.agent.get(res.headers.location).expect(200);
    expect(page.text).toContain('Landmark: Near the filling station');
    expect(page.text).not.toContain('(near Near');
    expect(page.text).toContain('+234 803 123 4567');
  });
});
