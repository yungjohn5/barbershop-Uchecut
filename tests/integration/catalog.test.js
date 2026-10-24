// Owner sections over HTTP: role guard, services and categories, zones, barbers (hours,
// time off), products, gallery and site photos uploaded to (mocked) Cloudinary.
process.env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
process.env.CLOUDINARY_FOLDER = 'victory/test';
jest.mock('cloudinary', () => require('../helpers/cloudinaryMock'));
const cloud = require('../helpers/cloudinaryMock');
const request = require('supertest');
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

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE "session", "Admin" RESTART IDENTITY');
  fx = await seedFixtures();
  cloud.reset();
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.admin.createMany({
    data: [
      { email: 'owner@test.ng', name: 'Ada', role: 'OWNER', passwordHash },
      { email: 'staff@test.ng', name: 'Sam', role: 'STAFF', passwordHash },
    ],
  });
});
afterAll(async () => {
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

describe('uploads (Cloudinary)', () => {
  const upload = (agent, csrf, url, fields, file = cloud.jpeg()) => {
    let req = agent.post(url).field('_csrf', csrf);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('image', file, 'photo.jpg');
  };

  test('multipart forms still need the CSRF token', async () => {
    const { agent } = await signIn();
    await agent
      .post('/admin/products')
      .field('name', 'Clay')
      .attach('image', cloud.jpeg(), 'clay.jpg')
      .expect(403);
    expect(cloud.v2.uploader.upload_stream).not.toHaveBeenCalled();
  });

  test('a product photo is uploaded to its folder; only publicId/version/size are stored', async () => {
    const { agent, csrf } = await signIn();
    await upload(agent, csrf, '/admin/products', {
      name: 'Matte Clay',
      price: '9500',
      visible: 'on',
    })
      .expect(303)
      .expect('Location', '/admin/products');
    const p = await prisma.product.findFirst({ where: { name: 'Matte Clay' } });
    expect(p).toMatchObject({
      priceKobo: 950000,
      imagePublicId: expect.stringMatching(/^victory\/test\/products\/matte-clay-/),
      imageVersion: expect.any(Number),
      imageWidth: 1000,
      imageHeight: 800,
      legacyImagePath: null,
    });
    expect(cloud.state.uploads[0].opts).toMatchObject({
      folder: 'victory/test/products',
      resource_type: 'image',
    });
    const html = (await request(app).get('/')).text;
    expect(html).toContain(
      `https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,c_fill,w_800/v${p.imageVersion}/${p.imagePublicId}`,
    );
  });

  test('replacing a photo deletes the old one; deleting the record deletes its photo', async () => {
    const { agent, csrf } = await signIn();
    await upload(agent, csrf, '/admin/products', { name: 'Clay', visible: 'on' }).expect(303);
    const first = await prisma.product.findFirst({ where: { name: 'Clay' } });
    await upload(agent, csrf, `/admin/products/${first.id}`, {
      name: 'Clay',
      visible: 'on',
    }).expect(303);
    await images.settled();
    const second = await prisma.product.findUnique({ where: { id: first.id } });
    expect(second.imagePublicId).not.toBe(first.imagePublicId);
    expect(cloud.state.destroyed).toEqual([first.imagePublicId]);

    await agent
      .post(`/admin/products/${first.id}/delete`)
      .type('form')
      .send({ _csrf: csrf })
      .expect(303);
    await images.settled();
    expect(cloud.state.destroyed).toEqual([first.imagePublicId, second.imagePublicId]);
  });

  test('a failed delete on Cloudinary is logged and does not block the save', async () => {
    const { agent, csrf } = await signIn();
    await upload(agent, csrf, '/admin/products', { name: 'Clay', visible: 'on' }).expect(303);
    const p = await prisma.product.findFirst();
    cloud.state.destroyFail = true;
    await upload(agent, csrf, `/admin/products/${p.id}`, { name: 'Clay', visible: 'on' })
      .expect(303)
      .expect('Location', '/admin/products');
    await images.settled();
    expect(cloud.state.destroyed).toEqual([p.imagePublicId]);
    const after = await prisma.product.findUnique({ where: { id: p.id } });
    expect(after.imagePublicId).not.toBe(p.imagePublicId);
  });

  test('files that aren’t JPEG/PNG/WebP never reach Cloudinary', async () => {
    const { agent, csrf } = await signIn();
    await upload(agent, csrf, '/admin/gallery', {}, Buffer.from('#!/bin/sh\necho hi'))
      .expect(303)
      .expect('Location', '/admin/gallery');
    await upload(
      agent,
      csrf,
      '/admin/gallery',
      {},
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    ).expect(303);
    expect(cloud.v2.uploader.upload_stream).not.toHaveBeenCalled();
    expect(await prisma.galleryItem.count()).toBe(0);
    expect((await agent.get('/admin/gallery')).text).toMatch(/isn’t an image/);
  });

  test('too-small images are refused and removed from Cloudinary again', async () => {
    const { agent, csrf } = await signIn();
    cloud.state.width = 300;
    await upload(agent, csrf, '/admin/gallery', { caption: 'Tiny' }).expect(303);
    await images.settled();
    expect(await prisma.galleryItem.count()).toBe(0);
    expect(cloud.state.destroyed).toEqual([cloud.state.uploads[0].result.public_id]);
    expect((await agent.get('/admin/gallery')).text).toMatch(/too small/);
  });

  test('a Cloudinary outage shows a friendly error and saves nothing', async () => {
    const { agent, csrf } = await signIn();
    cloud.state.fail = true;
    await upload(agent, csrf, '/admin/products', { name: 'Clay', visible: 'on' })
      .expect(303)
      .expect('Location', '/admin/products/new');
    expect(await prisma.product.count()).toBe(0);
    expect((await agent.get('/admin/products/new')).text).toMatch(/Couldn’t upload the photo/);
  });

  test('gallery: upload, caption, delete removes the photo from Cloudinary', async () => {
    const { agent, csrf } = await signIn();
    await upload(agent, csrf, '/admin/gallery', { caption: 'Low taper', visible: 'on' }).expect(
      303,
    );
    const g = await prisma.galleryItem.findFirst();
    expect(g).toMatchObject({
      caption: 'Low taper',
      visible: true,
      imagePublicId: expect.stringContaining('victory/test/gallery/'),
    });
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
    await images.settled();
    expect(cloud.state.destroyed).toEqual([g.imagePublicId]);
  });

  test('barber portrait replace deletes the old portrait', async () => {
    const { agent, csrf } = await signIn();
    const url = `/admin/barbers/${fx.homeBarber.id}`;
    await upload(agent, csrf, url, { name: 'Home Barber', active: 'on' }).expect(303);
    const a = await prisma.barber.findUnique({ where: { id: fx.homeBarber.id } });
    expect(a.photoPublicId).toContain('victory/test/barbers/home-barber-');
    await upload(agent, csrf, url, { name: 'Home Barber', active: 'on' }).expect(303);
    await images.settled();
    expect(cloud.state.destroyed).toEqual([a.photoPublicId]);
  });

  test('site photos: upload a hero, the home page uses it; restore brings back the placeholder', async () => {
    const { agent, csrf } = await signIn();
    expect((await request(app).get('/')).text).toContain('/images/site/hero-1400.webp');
    await upload(agent, csrf, '/admin/settings/photos/hero', {})
      .expect(303)
      .expect('Location', '/admin/settings#photos');
    const row = await prisma.setting.findUnique({ where: { key: 'siteImages' } });
    expect(row.value.hero.publicId).toContain('victory/test/site/hero-');
    const home = (await request(app).get('/')).text;
    expect(home).toContain(`/v${row.value.hero.version}/${row.value.hero.publicId}`);
    expect(home).not.toContain('/images/site/hero-1400.webp');

    const settingsPage = (await agent.get('/admin/settings')).text;
    const token = /name="csrf-token" content="([^"]+)"/.exec(settingsPage)[1];
    await agent
      .post('/admin/settings/photos/hero/reset')
      .type('form')
      .send({ _csrf: token })
      .expect(303);
    await images.settled();
    expect(cloud.state.destroyed).toEqual([row.value.hero.publicId]);
    expect((await request(app).get('/')).text).toContain('/images/site/hero-1400.webp');
  });
});
