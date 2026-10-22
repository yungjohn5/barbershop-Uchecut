// Owner sections over HTTP: role guard, services and categories, zones, barbers (hours,
// time off), products and gallery uploads through multipart + CSRF.
const path = require('path');
const fs = require('fs/promises');
const request = require('supertest');
const sharp = require('sharp');
const { Pool } = require('pg');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createApp } = require('../../src/app');
const { addDays, toShopDate, wallClockToUtc } = require('../../src/lib/time');
const { hashPassword } = require('../../src/services/adminAuth');
const { createBooking } = require('../../src/services/booking');
const images = require('../../src/services/images');

const PASSWORD = 'barbershop2026';
let app;
let pool;
let fx;
const uploaded = [];

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE "session", "Admin" RESTART IDENTITY');
  fx = await seedFixtures();
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.admin.createMany({
    data: [
      { email: 'owner@test.ng', name: 'Ada', role: 'OWNER', passwordHash },
      { email: 'staff@test.ng', name: 'Sam', role: 'STAFF', passwordHash },
    ],
  });
});
afterAll(async () => {
  // Remove any files the upload tests wrote to public/uploads.
  for (const [base, kind] of uploaded) await images.removeUpload(base, { kind });
  await pool.end();
  await prisma.$disconnect();
});

const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
async function signIn(email = 'owner@test.ng') {
  const agent = request.agent(app);
  const page = await agent.get('/admin/login');
  await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrfOf(page.text), email, password: PASSWORD })
    .expect(302);
  const home = await agent.get('/admin').expect(200);
  return { agent, csrf: csrfOf(home.text) };
}
const photo = (w = 1000, h = 800) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#333' } })
    .jpeg()
    .toBuffer();

describe('owner-only sections', () => {
  test('staff accounts get a friendly 403 and no Shop menu', async () => {
    const { agent, csrf } = await signIn('staff@test.ng');
    const res = await agent.get('/admin/services').expect(403);
    expect(res.text).toMatch(/This area is for the owner/);
    await agent
      .post('/admin/zones')
      .type('form')
      .send({ _csrf: csrf, name: 'Ajah', fee: '1000', travelBufferMin: '30' })
      .expect(403);
    expect((await agent.get('/admin')).text).not.toContain('href="/admin/services"');
  });

  test('owners see every section', async () => {
    const { agent } = await signIn();
    for (const url of [
      '/admin/services',
      '/admin/services/new',
      `/admin/services/${fx.cut.id}`,
      '/admin/barbers',
      '/admin/barbers/new',
      `/admin/barbers/${fx.homeBarber.id}`,
      '/admin/zones',
      '/admin/zones/new',
      `/admin/zones/${fx.zone.id}`,
      '/admin/products',
      '/admin/products/new',
      '/admin/gallery',
    ]) {
      await agent.get(url).expect(200);
    }
  });
});

describe('services and categories', () => {
  test('create a service offered by one barber; it gets a unique slug and sort order', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/services')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Cut',
        price: '8,000',
        durationMin: '40',
        categoryId: fx.cut.categoryId,
        active: 'on',
        barberIds: [fx.shopBarber.id],
      })
      .expect(303)
      .expect('Location', '/admin/services');
    const s = await prisma.service.findFirst({
      where: { slug: 'cut-2' },
      include: { barbers: true },
    });
    expect(s).toMatchObject({
      priceKobo: 800000,
      durationMin: 40,
      homeAvailable: false,
      active: true,
    });
    expect(s.barbers.map((b) => b.barberId)).toEqual([fx.shopBarber.id]);
  });

  test('validation errors come back on the form with the input kept', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/services')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Beard Sculpt',
        price: 'lots',
        durationMin: '45',
        categoryId: fx.cut.categoryId,
      })
      .expect(303)
      .expect('Location', '/admin/services/new');
    const form = await agent.get('/admin/services/new').expect(200);
    expect(form.text).toContain('value="Beard Sculpt"');
    expect(form.text).toMatch(/Enter the price in naira/);
  });

  test('hide, reorder and edit', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post(`/admin/services/${fx.cut.id}/active`)
      .type('form')
      .send({ _csrf: csrf, active: 'false' })
      .expect(303);
    expect((await prisma.service.findUnique({ where: { id: fx.cut.id } })).active).toBe(false);

    await agent
      .post(`/admin/services/${fx.shave.id}/move`)
      .type('form')
      .send({ _csrf: csrf, dir: 'up' })
      .expect(303);
    const order = await prisma.service.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    expect(order.map((s) => s.id)).toEqual([fx.shave.id, fx.cut.id]);

    await agent
      .post(`/admin/services/${fx.cut.id}`)
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Classic Cut',
        price: '7500',
        durationMin: '30',
        categoryId: fx.cut.categoryId,
        homeAvailable: 'on',
        active: 'on',
        barberIds: [fx.homeBarber.id, fx.shopBarber.id],
      })
      .expect(303);
    expect(await prisma.service.findUnique({ where: { id: fx.cut.id } })).toMatchObject({
      name: 'Classic Cut',
      slug: 'classic-cut',
      active: true,
    });
  });

  test('services with bookings can’t be deleted; unused ones can', async () => {
    const { agent, csrf } = await signIn();
    await createBooking({
      type: 'SHOP',
      serviceIds: [fx.cut.id],
      barberId: fx.homeBarber.id,
      startsAt: wallClockToUtc(addDays(toShopDate(new Date()), 3), 660).toISOString(),
      customer: { name: 'Kemi', phone: '08030000001' },
    });
    await agent
      .post(`/admin/services/${fx.cut.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(await prisma.service.findUnique({ where: { id: fx.cut.id } })).not.toBeNull();
    await agent
      .post(`/admin/services/${fx.shave.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(await prisma.service.findUnique({ where: { id: fx.shave.id } })).toBeNull();
  });

  test('categories: add, refuse duplicates, refuse deleting a non-empty one', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/categories')
      .type('form')
      .send({ _csrf: csrf, name: 'Colour' })
      .expect(303);
    await agent
      .post('/admin/categories')
      .type('form')
      .send({ _csrf: csrf, name: 'colour' })
      .expect(303);
    expect(
      await prisma.serviceCategory.count({
        where: { name: { equals: 'colour', mode: 'insensitive' } },
      }),
    ).toBe(1);
    await agent
      .post(`/admin/categories/${fx.cut.categoryId}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(
      await prisma.serviceCategory.findUnique({ where: { id: fx.cut.categoryId } }),
    ).not.toBeNull();
    const colour = await prisma.serviceCategory.findFirst({ where: { name: 'Colour' } });
    await agent
      .post(`/admin/categories/${colour.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(await prisma.serviceCategory.findUnique({ where: { id: colour.id } })).toBeNull();
  });
});

describe('zones', () => {
  test('create and edit; a zone with bookings can’t be deleted', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/zones')
      .type('form')
      .send({ _csrf: csrf, name: 'Ajah', fee: '6,500', travelBufferMin: '50', active: 'on' })
      .expect(303);
    expect(await prisma.zone.findUnique({ where: { name: 'Ajah' } })).toMatchObject({
      feeKobo: 650000,
      travelBufferMin: 50,
      active: true,
    });

    await createBooking({
      type: 'HOME',
      serviceIds: [fx.cut.id],
      zoneId: fx.zone.id,
      barberId: fx.homeBarber.id,
      startsAt: wallClockToUtc(addDays(toShopDate(new Date()), 3), 720).toISOString(),
      customer: { name: 'Kemi', phone: '08030000001' },
      address: '1 Test Rd',
    });
    await agent
      .post(`/admin/zones/${fx.zone.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(await prisma.zone.findUnique({ where: { id: fx.zone.id } })).not.toBeNull();
  });
});

describe('barbers', () => {
  test('a new barber starts with no hours, then gets a schedule and services', async () => {
    const { agent, csrf } = await signIn();
    const res = await agent
      .post('/admin/barbers')
      .type('form')
      .send({
        _csrf: csrf,
        name: 'Bayo K.',
        specialties: 'Tapers, Waves',
        active: 'on',
        serviceIds: [fx.cut.id],
      })
      .expect(303);
    const b = await prisma.barber.findFirst({
      where: { name: 'Bayo K.' },
      include: { services: true },
    });
    expect(res.headers.location).toBe(`/admin/barbers/${b.id}#hours`);
    expect(b).toMatchObject({
      slug: 'bayo-k',
      specialties: ['Tapers', 'Waves'],
      doesHomeService: false,
    });
    expect(b.services.map((s) => s.serviceId)).toEqual([fx.cut.id]);

    await agent
      .post(`/admin/barbers/${b.id}/hours`)
      .type('form')
      .send({
        _csrf: csrf,
        open_1: 'on',
        start_1: '09:00',
        end_1: '17:00',
        open_6: 'on',
        start_6: '10:00',
        end_6: '14:00',
      })
      .expect(303);
    const hours = await prisma.workingHours.findMany({
      where: { barberId: b.id },
      orderBy: { weekday: 'asc' },
    });
    expect(hours.map((h) => [h.weekday, h.startMin, h.endMin])).toEqual([
      [1, 540, 1020],
      [6, 600, 840],
    ]);
  });

  test('invalid hours keep the old schedule', async () => {
    const { agent, csrf } = await signIn();
    const before = await prisma.workingHours.count({ where: { barberId: fx.homeBarber.id } });
    await agent
      .post(`/admin/barbers/${fx.homeBarber.id}/hours`)
      .type('form')
      .send({ _csrf: csrf, open_1: 'on', start_1: '18:00', end_1: '09:00' })
      .expect(303);
    expect(await prisma.workingHours.count({ where: { barberId: fx.homeBarber.id } })).toBe(before);
    const page = await agent.get(`/admin/barbers/${fx.homeBarber.id}`);
    expect(page.text).toMatch(/Monday: the end must be after the start/);
  });

  test('time off blocks slots and warns about clashing bookings', async () => {
    const { agent, csrf } = await signIn();
    const date = addDays(toShopDate(new Date()), 4);
    const booking = await createBooking({
      type: 'SHOP',
      serviceIds: [fx.cut.id],
      barberId: fx.homeBarber.id,
      startsAt: wallClockToUtc(date, 780).toISOString(),
      customer: { name: 'Kemi', phone: '08030000001' },
    });
    await agent
      .post(`/admin/barbers/${fx.homeBarber.id}/time-off`)
      .type('form')
      .send({ _csrf: csrf, fromDate: date, fromTime: '12:00', toTime: '15:00', reason: 'Dentist' })
      .expect(303);
    const page = await agent.get(`/admin/barbers/${fx.homeBarber.id}`);
    expect(page.text).toContain(booking.reference);
    expect(page.text).toContain('Dentist');

    const slots = await request(app).get(
      `/api/slots?date=${date}&barber=${fx.homeBarber.id}&services=${fx.cut.id}&type=SHOP`,
    );
    expect(slots.body.slots.map((s) => s.time)).not.toContain('12:30');

    const off = await prisma.timeOff.findFirst({ where: { barberId: fx.homeBarber.id } });
    await agent
      .post(`/admin/barbers/${fx.homeBarber.id}/time-off/${off.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    expect(await prisma.timeOff.count()).toBe(0);
  });
});

describe('uploads', () => {
  test('multipart forms still need the CSRF token', async () => {
    const { agent } = await signIn();
    await agent
      .post('/admin/products')
      .field('name', 'Clay')
      .attach('image', await photo(), 'clay.jpg')
      .expect(403);
  });

  test('a product photo is resized into the upload folder', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/products')
      .field('_csrf', csrf)
      .field('name', 'Matte Clay')
      .field('price', '9500')
      .field('visible', 'on')
      .attach('image', await photo(), 'clay.jpg')
      .expect(303)
      .expect('Location', '/admin/products');
    const p = await prisma.product.findFirst({ where: { name: 'Matte Clay' } });
    uploaded.push([p.imageUrl, 'products']);
    expect(p).toMatchObject({ priceKobo: 950000, visible: true });
    expect(p.imageUrl).toMatch(/^\/uploads\/products\/matte-clay-/);
    await expect(
      fs.access(path.join(__dirname, '../../public', `${p.imageUrl}-800.webp`)),
    ).resolves.toBeUndefined();
    await request(app)
      .get(`${p.imageUrl}-400.webp`)
      .expect(200)
      .expect('Content-Type', /image\/webp/);
  });

  test('a file that isn’t an image is rejected with a message', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/gallery')
      .field('_csrf', csrf)
      .attach('image', Buffer.from('#!/bin/sh\necho hi'), 'run.jpg')
      .expect(303)
      .expect('Location', '/admin/gallery');
    expect(await prisma.galleryItem.count()).toBe(0);
    expect((await agent.get('/admin/gallery')).text).toMatch(/isn’t an image/);
  });

  test('gallery: upload, caption, delete removes the files', async () => {
    const { agent, csrf } = await signIn();
    await agent
      .post('/admin/gallery')
      .field('_csrf', csrf)
      .field('caption', 'Low taper')
      .field('visible', 'on')
      .attach('image', await photo(1400, 1000), 'cut.jpg')
      .expect(303);
    const g = await prisma.galleryItem.findFirst();
    expect(g).toMatchObject({ caption: 'Low taper', visible: true });
    await agent
      .post(`/admin/gallery/${g.id}`)
      .type('form')
      .send({ _csrf: csrf, caption: 'Low taper, waves', barberId: fx.homeBarber.id })
      .expect(303);
    expect(await prisma.galleryItem.findUnique({ where: { id: g.id } })).toMatchObject({
      caption: 'Low taper, waves',
      barberId: fx.homeBarber.id,
      visible: false,
    });
    await agent
      .post(`/admin/gallery/${g.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    await expect(
      fs.access(path.join(__dirname, '../../public', `${g.imageUrl}-600.webp`)),
    ).rejects.toThrow();
  });
});
