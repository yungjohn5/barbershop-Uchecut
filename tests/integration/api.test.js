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
  fx = await seedFixtures();
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

// Real clock here, so pick a date safely inside lead time and booking window.
const date = () => addDays(toShopDate(new Date()), 3);

describe('JSON API', () => {
  test('GET /api/zones lists active zones', async () => {
    const res = await request(app).get('/api/zones').expect(200);
    expect(res.body.zones).toEqual([
      { id: fx.zone.id, name: 'Lekki', feeKobo: 300000, travelBufferMin: 30 },
    ]);
  });

  test('GET /api/services?type=HOME hides shop-only services', async () => {
    const all = await request(app).get('/api/services').expect(200);
    const home = await request(app).get('/api/services?type=HOME').expect(200);
    expect(all.body.services.map((s) => s.slug)).toEqual(['cut', 'shave']);
    expect(home.body.services.map((s) => s.slug)).toEqual(['cut']);
  });

  test('GET /api/slots returns slots with barber ids and totals', async () => {
    const res = await request(app)
      .get(
        `/api/slots?date=${date()}&barber=any&services=${fx.cut.id}&type=HOME&zone=${fx.zone.id}`,
      )
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      date: date(),
      type: 'HOME',
      totalKobo: 1050000,
      bufferMin: 30,
    });
    expect(res.body.slots[0]).toEqual({
      time: '10:30',
      startsAt: expect.any(String),
      barberIds: [fx.homeBarber.id],
    });
  });

  test('GET /api/slots validates input', async () => {
    const res = await request(app).get('/api/slots?date=2030-02-30&services=abc').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const home = await request(app)
      .get(`/api/slots?date=${date()}&services=${fx.shave.id}&type=HOME&zone=${fx.zone.id}`)
      .expect(400);
    expect(home.body.error.code).toBe('HOME_NOT_AVAILABLE');
  });

  test('home page renders', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('Take the Chair');
    expect(res.text).toContain('Book a home visit');
  });

  test('POST without a CSRF token is rejected', async () => {
    await request(app).post('/').type('form').send({ a: 1 }).expect(403);
  });
});
