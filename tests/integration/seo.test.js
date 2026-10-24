// SEO over HTTP: head tags, JSON-LD on the home page, noindex on private pages, crawler files.
const request = require('supertest');
const { Pool } = require('pg');
const { prisma } = require('./fixtures');
const { createApp } = require('../../src/app');

let app;
let pool;
beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  app = createApp({ sessionPool: pool });
});
afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

test('home page: canonical, Open Graph, Twitter card, icons and BarberShop JSON-LD', async () => {
  const res = await request(app).get('/?utm_source=x').expect(200);
  const html = res.text;
  expect(html).toMatch(/<link rel="canonical" href="http:\/\/localhost:\d+\/" \/>/);
  expect(html).toContain('<meta property="og:image:width" content="1200" />');
  expect(html).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+" \/>/);
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');

  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const ld = JSON.parse(m[1]);
  expect(ld['@type']).toBe('BarberShop');
  expect(ld.potentialAction.target).toMatch(/\/book$/);
  expect(html).not.toContain('noindex');
});

test('only the home page carries JSON-LD', async () => {
  const res = await request(app).get('/book').expect(200);
  expect(res.text).not.toContain('application/ld+json');
  expect(res.text).toMatch(/<link rel="canonical" href="[^"]+\/book" \/>/);
});

test('private pages are noindex (header + meta) and have no canonical', async () => {
  const res = await request(app).get('/manage/not-a-real-token');
  expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(res.text).toContain('<meta name="robots" content="noindex, nofollow" />');
  expect(res.text).not.toContain('rel="canonical"');

  const missing = await request(app).get('/no-such-page').expect(404);
  expect(missing.text).toContain('noindex');
});

test('robots.txt, sitemap.xml and the manifest are served without a session cookie', async () => {
  const robots = await request(app).get('/robots.txt').expect(200);
  expect(robots.type).toBe('text/plain');
  expect(robots.text).toContain('Disallow: /admin');
  expect(robots.headers['set-cookie']).toBeUndefined();

  const map = await request(app).get('/sitemap.xml').expect(200);
  expect(map.type).toBe('application/xml');
  expect(map.text).toContain('<urlset');

  const manifest = await request(app).get('/site.webmanifest').expect(200);
  expect(manifest.type).toBe('application/manifest+json');
  expect(JSON.parse(manifest.text).icons.length).toBeGreaterThanOrEqual(3);

  await request(app).get('/icons/icon-512.png').expect(200);
  await request(app).get('/images/og-default.jpg').expect(200);
});
