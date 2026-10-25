// Launch readiness: placeholder detection, and no hardcoded shop content in templates.
const fs = require('fs');
const path = require('path');
const { contentGaps } = require('../../src/services/launch');
const { DEFAULT_SETTINGS } = require('../../src/config/constants');
const { SITE_SLOTS } = require('../../src/lib/images');

const real = {
  ...DEFAULT_SETTINGS,
  shop: {
    ...DEFAULT_SETTINGS.shop,
    address: ['12 Admiralty Way', 'Lekki Phase 1, Lagos'],
    phone: '+2348031234567',
    whatsapp: '2348031234567',
    email: 'hello@victorybarbershop.ng',
    hoursText: ['Mon–Sat · 9:00 – 19:00'],
    lat: 6.4281,
    lng: 3.4219,
    socials: { instagram: 'https://instagram.com/victory', tiktok: '', x: '', youtube: '' },
  },
  home: { ...DEFAULT_SETTINGS.home, heroText: 'Our own words.' },
  siteImages: Object.fromEntries(
    Object.keys(SITE_SLOTS).map((slot) => [
      slot,
      { publicId: `v/site/${slot}`, version: 1, width: 2000, height: 1300 },
    ]),
  ),
};
const cloud = { imagePublicId: 'v/x', photoPublicId: 'v/y' };
const ready = {
  settings: real,
  services: [{ id: 1, name: 'Skin Fade', active: true, ...cloud }],
  barbers: [{ id: 7, name: 'Tunde', active: true, bio: 'Fades.', ...cloud }],
  products: [{ id: 1, visible: true, ...cloud }],
  zones: [{ id: 1, active: true }],
  hours: [{ barberId: 7 }],
  gallery: [{ id: 1, visible: true, ...cloud }],
};
const keys = (gaps) => gaps.map((g) => g.key);

describe('launch checklist', () => {
  test('a fully set-up shop has nothing left', () => {
    expect(contentGaps(ready)).toEqual([]);
  });

  test('a fresh install flags every placeholder, must-dos first', () => {
    const gaps = contentGaps({
      settings: DEFAULT_SETTINGS,
      barbers: [
        {
          id: 3,
          name: 'Emeka',
          active: true,
          bio: '',
          legacyPhotoPath: '/images/site/barber-emeka',
        },
      ],
    });
    expect(keys(gaps)).toEqual(
      expect.arrayContaining([
        'address',
        'phone',
        'whatsapp',
        'email',
        'services',
        'hours',
        'site-photos',
        'barber-photos',
        'bios',
        'copy',
        'map-pin',
        'socials',
        'zones',
        'lookbook',
      ]),
    );
    const firstRecommended = gaps.findIndex((g) => g.level === 'recommended');
    expect(gaps.slice(firstRecommended).every((g) => g.level === 'recommended')).toBe(true);
    expect(gaps.find((g) => g.key === 'hours').label).toContain('Emeka');
  });

  test('stock photos and an example email count as placeholders; uploads do not', () => {
    const gaps = contentGaps({
      ...ready,
      settings: { ...real, shop: { ...real.shop, email: 'owner@example.com' } },
      services: [{ id: 1, name: 'Cut', active: true, legacyImagePath: '/images/site/svc-cut' }],
    });
    expect(keys(gaps)).toEqual(['email', 'service-photos']);
  });

  test('every gap links into the admin', () => {
    for (const g of contentGaps({ settings: DEFAULT_SETTINGS }))
      expect(g.href).toMatch(/^\/admin\//);
  });
});

describe('no hardcoded shop content in templates', () => {
  const views = path.join(__dirname, '..', '..', 'src', 'views');
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(d, e.name))
          : e.name.endsWith('.ejs')
            ? [path.join(d, e.name)]
            : [],
      );
  // Shop name, contact details and stock text must come from Settings, never the template.
  const banned = [
    /Victory Barbershop/,
    /example\.(com|org)/,
    /\+?234\s?80{3}/,
    /Placeholder address/i,
    /lorem ipsum/i,
    /wa\.me\/\d/,
  ];

  test.each(walk(views).map((f) => [path.relative(views, f), f]))('%s', (_rel, file) => {
    const text = fs.readFileSync(file, 'utf8').replace(/placeholder="[^"]*"/g, ''); // input hints are fine
    for (const re of banned) expect(text).not.toMatch(re);
  });
});
