// HTTP hardening: health check, security headers, CSP, cookies.
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
  jest.restoreAllMocks();
  await pool.end();
  await prisma.$disconnect();
});

test('/healthz pings the database: 200 when up, 503 when not', async () => {
  const up = await request(app).get('/healthz').expect(200);
  expect(up.body).toEqual({ ok: true, db: 'up' });
  expect(up.headers['cache-control']).toBe('no-store');

  jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
  const down = await request(app).get('/healthz').expect(503);
  expect(down.body).toEqual({ ok: false, db: 'down' });
});

test('CSP: scripts from self only, images from self (no wildcard), fonts from Google', async () => {
  const res = await request(app).get('/').expect(200);
  const csp = res.headers['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toMatch(/img-src 'self' data: blob:(;| https:\/\/res\.cloudinary\.com;)/);
  expect(csp).not.toMatch(/img-src[^;]* https:(;| )/);
  expect(csp).toContain('font-src');
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  // no inline scripts anywhere on the page (JSON-LD is a data block, never executed)
  expect(res.text).not.toMatch(/<script(?![^>]*\b(?:src=|type="application\/ld\+json"))[^>]*>/);
});

test('HSTS only in production; session cookie is httpOnly', async () => {
  const res = await request(app).get('/book').expect(200);
  expect(res.headers['strict-transport-security']).toBeUndefined();
  const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('vb.sid='));
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
});

test('CSS/JS are linked with a content hash and cached for a year as immutable', async () => {
  const html = (await request(app).get('/').expect(200)).text;
  const css = html.match(/href="(\/css\/app\.css\?v=[0-9a-f]{10})"/);
  expect(css).not.toBeNull();
  expect(html).toMatch(/src="\/vendor\/gsap\/gsap\.min\.js\?v=[0-9a-f]{10}"/);
  const res = await request(app).get(css[1]).expect(200);
  expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  const plain = await request(app).get('/css/app.css').expect(200);
  expect(plain.headers['cache-control']).not.toContain('immutable');
});

test('photos, icons and fonts cache for 30 days; referrer shares only our origin', async () => {
  for (const p of [
    '/images/site/hero-800.webp',
    '/icons/icon-192.png',
    '/fonts/inter-latin.woff2',
    '/images/client/look-01-480.webp',
    '/media/reels/reel-01.mp4',
  ]) {
    const res = await request(app).get(p).expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=2592000');
  }
  const home = await request(app).get('/').expect(200);
  expect(home.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('home shows the logo lockup and the prepared reels, each lazy with a poster', async () => {
  const html = (await request(app).get('/').expect(200)).text;
  expect(html).toContain('<span class="brand-main">Verified Energy</span>');
  expect(html).toContain('<span class="brand-sub">Auch</span>');
  expect(html).toContain('href="/icons/icon-32.png"');
  const reels = html.split('id="reels"')[1].split('</section>')[0];
  const { REELS } = require('../../src/config/media');
  expect(reels.match(/<video/g)).toHaveLength(REELS.length);
  expect(reels).toContain('src="/media/reels/reel-01.mp4"');
  expect(reels).toContain('poster="/media/reels/reel-01-poster.webp"');
  expect(reels.match(/preload="none"/g)).toHaveLength(REELS.length);
});
