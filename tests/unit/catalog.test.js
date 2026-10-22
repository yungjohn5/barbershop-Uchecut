const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { nairaToKobo, koboToInput, slugify, parse, schemas } = require('../../src/services/catalog');
const { hhmmToMin, parseHours, parseTimeOff } = require('../../src/services/barbers');
const images = require('../../src/services/images');

describe('money input', () => {
  test('naira strings become kobo', () => {
    expect(nairaToKobo('7500')).toBe(750000);
    expect(nairaToKobo('₦7,500')).toBe(750000);
    expect(nairaToKobo(' 12,000.5 ')).toBe(1200050);
    expect(nairaToKobo('0.99')).toBe(99);
    expect(nairaToKobo('')).toBeNull();
    expect(nairaToKobo('abc')).toBeNaN();
    expect(nairaToKobo('1.234')).toBeNaN();
    expect(nairaToKobo('-5')).toBeNaN();
  });

  test('kobo goes back into the form without float noise', () => {
    expect(koboToInput(750000)).toBe('7500');
    expect(koboToInput(1200050)).toBe('12000.50');
    expect(koboToInput(null)).toBe('');
  });
});

describe('slugify', () => {
  test('makes URL-safe slugs', () => {
    expect(slugify('Beard Trim & Line-up')).toBe('beard-trim-and-line-up');
    expect(slugify('  Kids Cut (under 12) ')).toBe('kids-cut-under-12');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('!!!')).toBe('item');
  });
});

describe('form schemas', () => {
  test('service: coerces form strings', () => {
    expect(
      parse(schemas.service, {
        name: ' Skin Fade ',
        price: '9,000',
        durationMin: '45',
        categoryId: '2',
        homeAvailable: 'on',
        barberIds: ['1', '3'],
      }),
    ).toEqual({
      name: 'Skin Fade',
      description: null,
      price: 900000,
      durationMin: 45,
      categoryId: 2,
      homeAvailable: true,
      active: false,
      barberIds: [1, 3],
    });
  });

  test('service: reports every bad field with a readable message', () => {
    try {
      parse(schemas.service, { name: 'x', price: 'free', durationMin: '7' });
      throw new Error('should have thrown');
    } catch (err) {
      const byPath = Object.fromEntries(err.details.map((d) => [d.path, d.message]));
      expect(byPath.name).toBe('Enter a name.');
      expect(byPath.price).toMatch(/naira/);
      expect(byPath.durationMin).toBe('Use steps of 5 minutes.');
      expect(byPath.categoryId).toBe('Choose a category.');
    }
  });

  test('zone: travel time is bounded', () => {
    expect(() =>
      parse(schemas.zone, { name: 'Ajah', fee: '5000', travelBufferMin: '500' }),
    ).toThrow();
    expect(
      parse(schemas.zone, { name: 'Ajah', fee: '5000', travelBufferMin: '45', active: 'on' }),
    ).toEqual({
      name: 'Ajah',
      fee: 500000,
      travelBufferMin: 45,
      active: true,
    });
  });

  test('product: price is optional', () => {
    expect(parse(schemas.product, { name: 'Clay', price: '' }).price).toBeNull();
    expect(parse(schemas.product, { name: 'Clay', price: '9500' }).price).toBe(950000);
  });
});

describe('weekly hours', () => {
  test('hhmmToMin', () => {
    expect(hhmmToMin('10:30')).toBe(630);
    expect(hhmmToMin('24:00')).toBe(1440);
    expect(hhmmToMin('9:05')).toBe(545);
    expect(hhmmToMin('24:30')).toBeNull();
    expect(hhmmToMin('10:60')).toBeNull();
    expect(hhmmToMin('')).toBeNull();
  });

  test('only open days become shifts', () => {
    expect(
      parseHours({
        open_1: 'on',
        start_1: '10:00',
        end_1: '20:00',
        start_2: '10:00',
        end_2: '20:00',
      }),
    ).toEqual([{ weekday: 1, startMin: 600, endMin: 1200 }]);
  });

  test('bad days are named', () => {
    try {
      parseHours({
        open_1: 'on',
        start_1: '20:00',
        end_1: '10:00',
        open_6: 'on',
        start_6: '',
        end_6: '18:00',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.details).toEqual([
        { path: 'day_1', message: 'Monday: the end must be after the start.' },
        { path: 'day_6', message: 'Saturday: enter start and end times.' },
      ]);
    }
  });
});

describe('time off', () => {
  test('all day covers whole Lagos days', () => {
    const r = parseTimeOff({
      fromDate: '2026-12-24',
      toDate: '2026-12-26',
      allDay: 'on',
      reason: ' Christmas ',
    });
    expect(r.startsAt.toISOString()).toBe('2026-12-23T23:00:00.000Z'); // 00:00 WAT
    expect(r.endsAt.toISOString()).toBe('2026-12-26T23:00:00.000Z'); // 24:00 WAT on the 26th
    expect(r.reason).toBe('Christmas');
  });

  test('a few hours on one day', () => {
    const r = parseTimeOff({ fromDate: '2026-11-02', fromTime: '13:00', toTime: '14:30' });
    expect(r.startsAt.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(r.endsAt.toISOString()).toBe('2026-11-02T13:30:00.000Z');
  });

  test('end before start is rejected', () => {
    expect(() =>
      parseTimeOff({ fromDate: '2026-11-02', fromTime: '15:00', toTime: '14:00' }),
    ).toThrow(/after the start/);
    expect(() => parseTimeOff({ fromDate: 'soon', allDay: 'on' })).toThrow();
  });
});

describe('image uploads', () => {
  let root;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-img-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const jpeg = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: '#b8833e' } })
      .jpeg()
      .toBuffer();

  test('writes every width as WebP and returns the base path', async () => {
    const base = await images.saveUpload(await jpeg(1200, 900), {
      kind: 'products',
      name: 'Matte Clay!',
      root,
    });
    expect(base).toMatch(/^\/uploads\/products\/matte-clay-[0-9a-f]{8}$/);
    for (const w of images.WIDTHS.products) {
      const meta = await sharp(await fs.readFile(path.join(root, `${base}-${w}.webp`))).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: w });
    }
    await images.removeUpload(base, { kind: 'products', root });
    await expect(fs.access(path.join(root, `${base}-400.webp`))).rejects.toThrow();
  });

  test('rejects non-images and tiny images', async () => {
    await expect(
      images.saveUpload(Buffer.from('not an image'), { kind: 'gallery', name: 'x', root }),
    ).rejects.toThrow(/isn’t an image/);
    await expect(
      images.saveUpload(await jpeg(300, 300), { kind: 'gallery', name: 'x', root }),
    ).rejects.toThrow(/too small/);
  });

  test('removeUpload never leaves its own folder', async () => {
    await expect(
      images.removeUpload('/images/site/hero', { kind: 'products', root }),
    ).resolves.toBeUndefined();
    await expect(
      images.removeUpload('/uploads/products/../../x', { kind: 'products', root }),
    ).resolves.toBeUndefined();
  });
});
