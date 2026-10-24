// SEO helpers: canonical URLs, share image, BarberShop JSON-LD, robots, sitemap, manifest.
process.env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
const seo = require('../../src/services/seo');

const APP = 'https://victory.example/';
const shop = {
  name: 'Victory Barbershop',
  tagline: 'Sharp lines.',
  address: ['12 Admiralty Way', 'Lekki Phase 1', 'Lagos, Nigeria'],
  phone: '+2348031234567',
  email: 'hello@victory.ng',
  socials: { instagram: 'https://instagram.com/victory', tiktok: '', x: '', youtube: '' },
  lat: 6.4281,
  lng: 3.4219,
};
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 600, endMin: 1200 }));

describe('URLs', () => {
  test('canonical URLs come from APP_URL without query strings', () => {
    expect(seo.absoluteUrl('/book?step=2', APP)).toBe('https://victory.example/book');
    expect(seo.absoluteUrl('/', APP)).toBe('https://victory.example/');
    expect(seo.absoluteUrl('https://res.cloudinary.com/x.jpg', APP)).toBe(
      'https://res.cloudinary.com/x.jpg',
    );
  });

  test('admin, manage and confirmation pages are private', () => {
    expect(seo.isPrivatePath('/admin/settings')).toBe(true);
    expect(seo.isPrivatePath('/manage/abc')).toBe(true);
    expect(seo.isPrivatePath('/book/confirmed/VB-1')).toBe(true);
    expect(seo.isPrivatePath('/book')).toBe(false);
    expect(seo.isPrivatePath('/administrator')).toBe(false);
  });
});

describe('share image', () => {
  test('uploaded hero → Cloudinary 1200×630 JPEG crop', () => {
    const img = seo.ogImage({ hero: { publicId: 'v/site/hero', version: 5 } }, APP);
    expect(img).toEqual({
      url: 'https://res.cloudinary.com/test-cloud/image/upload/f_jpg,q_auto,c_fill,g_auto,w_1200,h_630/v5/v/site/hero',
      width: 1200,
      height: 630,
    });
  });

  test('placeholder hero → bundled 1200×630 fallback', () => {
    expect(seo.ogImage({}, APP).url).toBe('https://victory.example/images/og-default.jpg');
  });
});

describe('BarberShop JSON-LD', () => {
  const ld = seo.barberShopJsonLd({
    shop,
    hours: [...weekdays, { weekday: 6, startMin: 600, endMin: 1080 }],
    services: [{ priceKobo: 300000 }, { priceKobo: 1800000 }],
    image: 'https://img/og.jpg',
    appUrl: APP,
  });

  test('built from Settings', () => {
    expect(ld).toMatchObject({
      '@type': 'BarberShop',
      name: 'Victory Barbershop',
      url: 'https://victory.example/',
      telephone: '+2348031234567',
      address: { streetAddress: '12 Admiralty Way, Lekki Phase 1', addressCountry: 'NG' },
      geo: { latitude: 6.4281, longitude: 3.4219 },
      priceRange: '₦3,000–₦18,000',
      sameAs: ['https://instagram.com/victory'],
      image: ['https://img/og.jpg'],
    });
  });

  test('opening hours grouped from barbers’ shifts; closed days left out', () => {
    expect(ld.openingHoursSpecification).toEqual([
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '10:00',
        closes: '20:00',
      },
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Saturday'],
        opens: '10:00',
        closes: '18:00',
      },
    ]);
  });

  test('no map pin, hours or socials → those keys are omitted', () => {
    const bare = seo.barberShopJsonLd({
      shop: { ...shop, lat: null, lng: null, socials: {} },
      appUrl: APP,
    });
    expect(bare).not.toHaveProperty('geo');
    expect(bare).not.toHaveProperty('openingHoursSpecification');
    expect(bare).not.toHaveProperty('sameAs');
  });

  test('script output cannot close the <script> tag', () => {
    const out = seo.jsonLdScript({ name: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>');
  });
});

describe('crawler files', () => {
  test('robots.txt disallows private areas and points at the sitemap', () => {
    const txt = seo.robotsTxt(APP);
    for (const p of ['/admin', '/manage', '/book/confirmed'])
      expect(txt).toContain(`Disallow: ${p}`);
    expect(txt).toContain('Sitemap: https://victory.example/sitemap.xml');
  });

  test('sitemap lists the public pages with absolute URLs', () => {
    const xml = seo.sitemapXml({ appUrl: APP, lastmod: new Date('2026-10-24T00:00:00Z') });
    expect(xml).toContain('<loc>https://victory.example/</loc><lastmod>2026-10-24</lastmod>');
    expect(xml).toContain('<loc>https://victory.example/book</loc>');
    expect(xml).not.toContain('/admin');
  });

  test('manifest follows the shop name and ships a maskable icon', () => {
    const m = seo.webManifest(shop);
    expect(m.name).toBe('Victory Barbershop');
    expect(m.short_name).toBe('Victory');
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});
