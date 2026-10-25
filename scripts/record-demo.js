// Promo walkthrough recorder (Playwright). Builds a fresh DEMO database (base seed +
// scripts/seed-demo.js: made-up Nigerian names, fake 0803 000 00xx numbers, no real customer
// data), starts the app against it on http://localhost:3000, and records two videos:
//   vertical  1080×1920 (mobile UA, DPR 2) for Reels / TikTok / WhatsApp Status
//   landscape 1920×1080                    for LinkedIn / X
// Output goes to recordings/ (git-ignored). If ffmpeg is on PATH, an .mp4 is made too.
//
//   npm run record:demo                     both formats
//   npm run record:demo -- --only=vertical  one format (vertical | landscape)
//   npm run record:demo -- --headed         watch it run
//
// Needs the dev server stopped (it uses port 3000; override with DEMO_PORT). The demo
// database is DEMO_DATABASE_URL, or DATABASE_URL with the name changed to uchecut_demo; any
// database whose name doesn't end in _demo is refused, so dev data is never touched.
/* global window, document, addEventListener, requestAnimationFrame -- page.evaluate / addInitScript bodies run in the browser */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recordings');
const PORT = Number(process.env.DEMO_PORT || 3000);
const BASE = `http://localhost:${PORT}`;
const ADMIN = { email: 'owner@victory.example', password: 'demo-owner-2026!', name: 'Ada Okoro' };

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const headed = args.includes('--headed');

const FORMATS = {
  vertical: {
    label: 'vertical-1080x1920',
    viewport: { width: 540, height: 960 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    video: { width: 1080, height: 1920 },
  },
  landscape: {
    label: 'landscape-1920x1080',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    video: { width: 1920, height: 1080 },
  },
};

// ------------------------------------------------------------------ demo database + app
function demoDatabaseUrl() {
  const raw = process.env.DEMO_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('Set DATABASE_URL (or DEMO_DATABASE_URL) in .env.');
  const url = new URL(raw);
  if (!process.env.DEMO_DATABASE_URL) url.pathname = '/uchecut_demo';
  const name = url.pathname.slice(1);
  if (!/_demo$/.test(name))
    throw new Error(`Refusing to use "${name}": demo database names must end in _demo.`);
  return { url: url.toString(), name };
}

async function resetDatabase({ url, name }) {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

function run(label, command, cmdArgs, env) {
  const res = spawnSync(command, cmdArgs, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed:\n${(res.stdout || '') + (res.stderr || '')}`.trim());
  }
  const last = (res.stdout || '').trim().split('\n').pop();
  if (last) console.log(`  ${label}: ${last}`);
}

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });

async function startServer(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`App exited:\n${stderr}`);
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`App did not become healthy:\n${stderr}`);
}

async function barberIdBySlug(url, slug) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT id FROM "Barber" WHERE slug = $1', [slug]);
    return rows[0] && rows[0].id;
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------ in-page overlay
// Cursor dot + click ripple, drawn with CSSOM only (works under the site's CSP). The last
// position survives navigations so the dot doesn't jump in from a corner.
function cursorOverlay() {
  if (window.top !== window) return;
  const KEY = '__demoCursor';
  const make = () => {
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '22px',
      height: '22px',
      margin: '-11px 0 0 -11px',
      borderRadius: '50%',
      background: 'rgba(184, 131, 62, 0.95)',
      boxShadow: '0 0 0 3px rgba(255,255,255,0.9), 0 8px 22px rgba(0,0,0,0.35)',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    const place = (x, y) => {
      dot.style.transform = `translate(${x}px, ${y}px)`;
    };
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(KEY));
    } catch {
      saved = null;
    }
    place(saved ? saved.x : -60, saved ? saved.y : -60);
    document.documentElement.appendChild(dot);
    addEventListener(
      'mousemove',
      (e) => {
        place(e.clientX, e.clientY);
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ x: e.clientX, y: e.clientY }));
        } catch {
          /* ignore */
        }
      },
      true,
    );
    addEventListener(
      'mousedown',
      (e) => {
        const ring = document.createElement('div');
        Object.assign(ring.style, {
          position: 'fixed',
          left: `${e.clientX}px`,
          top: `${e.clientY}px`,
          width: '22px',
          height: '22px',
          margin: '-11px 0 0 -11px',
          borderRadius: '50%',
          border: '3px solid rgba(184, 131, 62, 0.9)',
          zIndex: '2147483646',
          pointerEvents: 'none',
        });
        document.documentElement.appendChild(ring);
        ring
          .animate(
            [
              { transform: 'scale(1)', opacity: 1 },
              { transform: 'scale(3.4)', opacity: 0 },
            ],
            { duration: 650, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
          )
          .finished.then(() => ring.remove());
        dot.animate(
          [{ transform: dot.style.transform + ' scale(0.75)' }, { transform: dot.style.transform }],
          {
            duration: 220,
          },
        );
      },
      true,
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
}

// ------------------------------------------------------------------ director helpers
function director(page) {
  const pos = { x: 40, y: 40 };
  const pause = (ms) => page.waitForTimeout(ms);

  // Eased scroll driven by requestAnimationFrame (works with ScrollSmoother on desktop).
  const scrollToY = (y, ms = 1400) =>
    page.evaluate(
      ({ y: target, ms: dur }) =>
        new Promise((resolve) => {
          const root = document.documentElement;
          root.style.scrollBehavior = 'auto';
          const start = window.scrollY;
          const max = root.scrollHeight - window.innerHeight;
          const to = Math.max(0, Math.min(target, max));
          const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
          const t0 = performance.now();
          const step = (now) => {
            const p = Math.min(1, (now - t0) / dur);
            window.scrollTo({ top: start + (to - start) * ease(p), behavior: 'instant' });
            if (p < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
      { y, ms },
    );

  const yOf = (selector, offset = 0) =>
    page.evaluate(
      ({ selector: sel, offset: off }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const smoother = window.Site && window.Site.smoother;
        const top = smoother
          ? smoother.offset(el, 'top top')
          : el.getBoundingClientRect().top + window.scrollY;
        return top - off;
      },
      { selector, offset },
    );

  const scrollTo = async (selector, { offset = 0, ms = 1500 } = {}) => {
    const y = await yOf(selector, offset);
    if (y !== null) await scrollToY(y, ms);
  };

  const scrollBy = async (dy, ms = 1400) => {
    const y = await page.evaluate(() => window.scrollY);
    await scrollToY(y + dy, ms);
  };

  // Bring an element into the middle of the screen (smoothly) if it isn't comfortably visible.
  const reveal = async (locator) => {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    const box = await locator.boundingBox();
    const vh = page.viewportSize().height;
    // Fixed/sticky UI (the phone's bottom bar, headers) is already on screen: never scroll for it.
    const pinned = await locator.evaluate((el) => {
      for (let n = el; n; n = n.parentElement) {
        const p = window.getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return true;
      }
      return false;
    });
    if (!pinned && (!box || box.y < vh * 0.12 || box.y + box.height > vh * 0.82)) {
      await locator.evaluate((el) => el.setAttribute('data-demo-target', ''));
      const y = await yOf('[data-demo-target]', vh / 2 - (box ? box.height / 2 : 0));
      await locator.evaluate((el) => el.removeAttribute('data-demo-target'));
      if (y !== null) await scrollToY(y, 550);
      await pause(120);
    }
    if (!pinned) await locator.scrollIntoViewIfNeeded(); // horizontal strips (dates, barbers)
    await pause(80); // let scroll-linked UI settle before measuring
  };

  const moveTo = async (locator) => {
    await reveal(locator);
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const dist = Math.hypot(x - pos.x, y - pos.y);
    // Each step is a round trip to the browser; ~6–16 steps reads as a smooth glide on video.
    await page.mouse.move(x, y, { steps: Math.max(6, Math.min(16, Math.round(dist / 40))) });
    pos.x = x;
    pos.y = y;
  };

  const click = async (locator, { before = 100, after = 350 } = {}) => {
    await moveTo(locator);
    // Wait until it's visible, stable, enabled and on top (no click yet).
    await locator.click({ trial: true, timeout: 10000 });
    await pause(before);
    await page.mouse.down();
    await pause(90);
    await page.mouse.up();
    await pause(after);
  };

  const type = async (locator, text) => {
    await click(locator, { after: 150 });
    await page.keyboard.type(text, { delay: 18 });
    await pause(150);
  };

  return { pause, scrollTo, scrollBy, scrollToY, reveal, moveTo, click, type };
}

// The step's submit: in the page on wide screens, in the sticky total bar on phones.
const nextButton = (page) =>
  page
    .locator('#step-form button[type="submit"], button[type="submit"][form="step-form"]')
    .filter({ visible: true })
    .first();

// Press the step's submit and wait for the next page. If the press didn't register (the
// phone's bottom bar can still be settling), fall back to a direct click so the take survives.
async function next(page, d, urlRe) {
  // The form POST is the proof the press registered (page loads can be slow while recording).
  let posted = false;
  let redirect = null;
  const onRequest = (r) => {
    if (r.method() === 'POST') posted = true;
  };
  const onResponse = (r) => {
    if (r.request().method() === 'POST' && r.headers().location) redirect = r.headers().location;
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await d.click(nextButton(page), { after: 0 });
    for (let waited = 0; !posted && waited < 4000; waited += 100) await d.pause(100);
    if (!posted) await nextButton(page).click();
    try {
      await page.waitForURL(urlRe, { timeout: 10000 });
    } catch (err) {
      // The server saved the step but the browser dropped the redirect (seen under heavy
      // load while encoding video): follow it ourselves.
      if (!redirect || !urlRe.test(redirect)) throw err;
      await page.goto(new URL(redirect, BASE).toString(), { waitUntil: 'load' });
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
  await d.pause(200);
}

// booking.js marks [data-slots] .is-loading while it fetches a day's times.
const slotsReady = (page) =>
  page.waitForFunction(() => {
    const box = document.querySelector('[data-slots]');
    return box && !box.classList.contains('is-loading');
  });

// Pick the first date (from `minDate`) that has free times, then a time a few slots in.
async function pickDateAndTime(page, d, { minDate }) {
  const chips = page.locator('a.date-chip[data-date-link]');
  const count = await chips.count();
  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    const date = await chip.getAttribute('data-date-link');
    if (date < minDate) continue;
    await d.click(chip, { after: 100 });
    await slotsReady(page);
    const slots = page.locator('[data-slots] label.slot');
    const n = await slots.count();
    if (!n) continue; // no free times that day
    await d.pause(250);
    // Prefer a time high on the list so it isn't hidden behind the phone's bottom bar.
    await d.click(slots.nth(Math.min(2, n - 1)), { after: 300 });
    await page.waitForFunction(
      () => document.querySelector('[data-slots] input[name="startsAt"]:checked'),
      null,
      { timeout: 3000 },
    );
    await d.pause(200);
    return date;
  }
  throw new Error(`No free times from ${minDate} in the date strip.`);
}

const lagosDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', {
    timeZone: 'Africa/Lagos',
  });

// ------------------------------------------------------------------ scenes
async function scenes(page, format, ids) {
  const t0 = Date.now();
  let last = t0;
  const mark = (label) => {
    if (!process.env.DEMO_DEBUG) return;
    const now = Date.now();
    console.log(
      `  [time] ${label}: ${((now - last) / 1000).toFixed(1)}s (total ${((now - t0) / 1000).toFixed(1)}s)`,
    );
    last = now;
  };
  const d = director(page);
  const desktop = format === 'landscape';
  const go = async (p) => {
    await page.goto(`${BASE}${p}`, { waitUntil: 'load' });
    await d.pause(200);
  };

  // 1. Home (~15s): hero (intro loader on desktop), a services tab, barbers, home visits,
  //    products, builder section.
  await go('/');
  await d.pause(desktop ? 3600 : 1500);
  await d.scrollTo('#services', { offset: desktop ? 40 : 10, ms: 1300 });
  const tabs = page.locator('#services button.tab[data-filter]');
  if ((await tabs.count()) > 2) await d.click(tabs.nth(2), { after: 800 });
  await d.scrollTo('#barbers', { offset: 20, ms: 1200 });
  await d.pause(600);
  await d.scrollTo('#home-service', { offset: 20, ms: 1100 });
  await d.pause(600);
  await d.scrollTo('#products', { offset: 0, ms: 1000 });
  if (desktop) await d.scrollBy(1400, 1800); // pinned product rail slides sideways
  await d.pause(400);
  await d.scrollTo('#built-by', { offset: 40, ms: 1200 });
  await d.pause(800);

  mark('home');

  // 2. Shop booking (~15s): two services, a barber, date, time, details, confirmation.
  await go('/book');
  await d.click(page.locator('label.choice:has(input[name="type"][value="SHOP"])'));
  await next(page, d, /\/book\/services/);
  await d.click(page.locator('label:has(input[data-name="Skin Fade"])'), { after: 300 });
  await d.click(page.locator('label:has(input[data-name="Beard Trim & Line-up"])'), { after: 500 });
  await next(page, d, /\/book\/time/);
  await d.click(page.locator('a.barber-chip', { hasText: 'Emeka' }), { after: 200 });
  await slotsReady(page);
  await pickDateAndTime(page, d, { minDate: lagosDate(1) });
  await next(page, d, /\/book\/details/);
  await d.type(page.locator('#f-name'), 'Kunle Adebanjo');
  await d.type(page.locator('#f-phone'), '0803 000 0091');
  await next(page, d, /\/book\/confirmed/);
  await d.pause(1500);

  mark('shop booking');

  // 3. Home visit (~10s): zone (travel fee shows), service, time, request received.
  await go('/book');
  await d.click(page.locator('label.choice:has(input[name="type"][value="HOME"])'), { after: 400 });
  await d.click(page.locator('label:has(input[data-zone-name="Lekki"])'), { after: 800 });
  await next(page, d, /\/book\/services/);
  await d.click(page.locator('label:has(input[data-name="Classic Haircut"])'), { after: 700 });
  await next(page, d, /\/book\/time/);
  const homeDate = await pickDateAndTime(page, d, { minDate: lagosDate(2) });
  await next(page, d, /\/book\/details/);
  await d.type(page.locator('#f-name'), 'Chidera Nwankwo');
  await d.type(page.locator('#f-phone'), '0803 000 0092');
  await d.type(page.locator('#f-address'), '15 Admiralty Way, Lekki');
  await next(page, d, /\/book\/confirmed/);
  await d.pause(1300);

  mark('home visit');

  // 4. Admin (~15s): Today, confirm the home request, week calendar with travel blocks, reports.
  await go('/admin/login');
  await d.type(page.locator('#a-email'), ADMIN.email);
  await d.click(page.locator('#a-password'), { after: 0 });
  await page.locator('#a-password').fill(ADMIN.password); // dots only; no need to watch it typed
  await d.click(page.locator('button[type="submit"]', { hasText: 'Sign in' }), { after: 200 });
  await page.waitForURL(`${BASE}/admin`);
  await d.pause(900);
  const confirm = page
    .locator('article.a-booking', { hasText: 'Chidera Nwankwo' })
    .getByRole('button', { name: 'Confirm', exact: true });
  await d.reveal(page.locator('#pending-h'));
  await d.click(confirm.first(), { after: 200 });
  await page.waitForURL(/\/admin\/bookings\/\d+/); // detail page: confirmed, address, travel fee
  await d.pause(1000);
  await d.scrollBy(400, 900);
  await d.pause(500);
  await go(`/admin/calendar?date=${homeDate}&barber=${ids.homeBarber}`);
  await d.pause(500);
  await d.moveTo(page.locator('.cal-event.cal-home').first());
  await d.pause(1000);
  await go('/admin/reports?preset=30d');
  await d.pause(800);
  await d.scrollBy(desktop ? 700 : 900, 1500);
  await d.pause(700);

  mark('admin');

  // 5. End on the builder section with its call to action in view.
  await go('/');
  await d.scrollTo('#built-by', { offset: desktop ? 60 : 20, ms: 1200 });
  const cta = page.locator('#built-by a', { hasText: /website like this/i }).first();
  await d.reveal(cta);
  await d.moveTo(cta);
  await d.pause(3000);
  mark('ending');
}

// ------------------------------------------------------------------ main
function ffmpegPath() {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf8',
  });
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0].trim() : null;
}

async function record(browser, name, ids, stamp) {
  const f = FORMATS[name];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-demo-'));
  const context = await browser.newContext({
    viewport: f.viewport,
    deviceScaleFactor: f.deviceScaleFactor,
    isMobile: f.isMobile,
    hasTouch: f.hasTouch,
    userAgent: f.userAgent,
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    colorScheme: 'light',
    recordVideo: { dir: tmp, size: f.video },
  });
  await context.addInitScript(cursorOverlay);
  const page = await context.newPage();
  if (process.env.DEMO_DEBUG) {
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
    page.on('response', (r) => {
      if (r.request().method() === 'POST')
        console.log(
          `  [POST] ${r.url().replace(BASE, '')} → ${r.status()} ${r.headers().location || ''}`,
        );
    });
  }
  const file = path.join(OUT, `victory-demo-${f.label}-${stamp}.webm`);
  try {
    // A take is ~1 minute; anything near 6 means it's stuck (e.g. the PC went to sleep).
    await withTimeout(scenes(page, name, ids), 6 * 60000, `${name} scenes`);
  } catch (err) {
    const shot = path.join(OUT, `error-${f.label}-${stamp}.png`);
    await withTimeout(page.screenshot({ path: shot }), 15000, 'screenshot').catch(() => {});
    err.message += `\n  (screenshot: ${shot})`;
    throw err;
  } finally {
    const video = page.video();
    await withTimeout(context.close(), 60000, 'closing the browser context').catch(() => {});
    if (video) await withTimeout(video.saveAs(file), 60000, 'saving the video').catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return file;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label} (${ms / 1000}s)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const names = only ? [only] : ['vertical', 'landscape'];
  if (names.some((n) => !FORMATS[n])) throw new Error('--only must be vertical or landscape.');
  if (!(await portFree(PORT))) {
    throw new Error(`Port ${PORT} is busy. Stop the dev server (npm run dev) or set DEMO_PORT.`);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const db = demoDatabaseUrl();
  const env = {
    ...process.env,
    DATABASE_URL: db.url,
    NODE_ENV: 'development',
    PORT: String(PORT),
    APP_URL: BASE,
    NOTIFY_MODE: 'log', // nothing is ever sent from a demo run
    CLOUDINARY_URL: '', // bundled photos; don't upload demo images
    LOG_LEVEL: 'warn',
    TZ: 'Africa/Lagos',
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_NAME: ADMIN.name,
  };

  console.log(`Preparing demo database ${db.name}…`);
  await resetDatabase(db);
  run(
    'migrate',
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    env,
  );
  run('base seed', process.execPath, ['prisma/seed.js'], env);
  run('demo seed', process.execPath, ['scripts/seed-demo.js'], env);
  run(
    'css',
    process.execPath,
    [
      'node_modules/tailwindcss/lib/cli.js',
      '-i',
      'src/styles/input.css',
      '-o',
      'public/css/app.css',
      '--minify',
    ],
    env,
  );
  const ids = { homeBarber: await barberIdBySlug(db.url, 'tunde') };

  console.log(`Starting the app on ${BASE}…`);
  const server = await startServer(env);
  const browser = await chromium.launch({ headless: !headed });
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`; // local time
  const files = [];
  try {
    for (const name of names) {
      console.log(`Recording ${name}…`);
      files.push(await record(browser, name, ids, stamp));
    }
  } finally {
    await browser.close();
    server.kill();
  }

  const ffmpeg = ffmpegPath();
  const outputs = [];
  for (const webm of files) {
    outputs.push(webm);
    if (!ffmpeg) continue;
    const mp4 = webm.replace(/\.webm$/, '.mp4');
    const res = spawnSync(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        webm,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { encoding: 'utf8' },
    );
    if (res.status === 0) outputs.push(mp4);
    else console.warn(`ffmpeg could not convert ${path.basename(webm)}: ${res.stderr}`);
  }

  console.log('\nDone. Recordings:');
  for (const f of outputs) console.log(`  ${f}`);
  if (!ffmpeg) console.log('  (WebM only: install ffmpeg to get .mp4 copies for Reels/TikTok.)');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
