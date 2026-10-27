// Promo video recorder (Playwright + Chrome screencast + ffmpeg).
//
// Builds a fresh DEMO database (base seed + scripts/seed-demo.js: made-up Nigerian names,
// fake 0803 000 00xx numbers, no real customer data), starts the app against it with
// DEMO_MODE=1 (setup-only UI hidden) and NOTIFY_MODE=log (nothing is ever sent), then
// records two videos into recordings/ (git-ignored):
//   verified-energy-demo-vertical.mp4   1080×1920  (viewport 540×960 at DPR 2, phone UA) Reels/TikTok/Status
//   verified-energy-demo-landscape.mp4  1920×1080                                           LinkedIn/X
// plus one still per scene in recordings/stills/.
//
// How: frames come from CDP Page.startScreencast at device resolution, each with its wall
// time. A capture clock pauses during page loads, slot fetches and reveal animations, so the
// video never shows a blank page, a half-loaded card or a freeze; ffmpeg turns the timed
// frames into 30 fps H.264 (yuv420p, +faststart). Holds on screen are capped at 1.5 s.
// Theme: starts dark, switches 4 times at scene transitions (seeded: DEMO_SEED, default 7)
// by clicking the header toggle, and ends on the Cyberninja promo in dark mode.
//
//   npm run record:demo                         both formats
//   npm run record:demo -- --only=vertical      one format (vertical | landscape)
//   npm run record:demo -- --webm               also write VP9 WebM copies
//   npm run record:demo -- --headed             watch it run
//   DEMO_SEED=11 npm run record:demo            a different (reproducible) theme pattern
//
// The demo database is DEMO_DATABASE_URL, or DATABASE_URL renamed to uchecut_demo; any name
// not ending in _demo is refused. The app runs on DEMO_PORT, else the first free port from 3100.
/* global window, document, addEventListener, requestAnimationFrame -- page.evaluate / addInitScript bodies run in the browser */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');
const FFMPEG = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recordings');
const STILLS = path.join(OUT, 'stills');
const ADMIN = {
  email: 'owner@verified-energy.example',
  password: 'demo-owner-2026!',
  name: 'Ada Okoro',
};
const SEED = Number(process.env.DEMO_SEED || 7);
const MAX_HOLD = 1500; // longest on-screen pause, ms

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const headed = args.includes('--headed');
const webm = args.includes('--webm');
const debug = Boolean(process.env.DEMO_DEBUG);

const FORMATS = {
  vertical: {
    file: 'verified-energy-demo-vertical',
    viewport: { width: 540, height: 960 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    size: { width: 1080, height: 1920 },
  },
  landscape: {
    file: 'verified-energy-demo-landscape',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    size: { width: 1920, height: 1080 },
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
  const res = spawnSync(command, cmdArgs, { cwd: ROOT, env, encoding: 'utf8' });
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

async function pickPort() {
  if (process.env.DEMO_PORT) {
    const p = Number(process.env.DEMO_PORT);
    if (!(await portFree(p))) throw new Error(`DEMO_PORT ${p} is busy.`);
    return p;
  }
  for (let p = 3100; p < 3120; p += 1) if (await portFree(p)) return p;
  throw new Error('No free port between 3100 and 3119; set DEMO_PORT.');
}

async function startServer(env, base) {
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
      const res = await fetch(`${base}/healthz`);
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

// Signed-in owner + dark theme, saved once and loaded into each recording context, so the
// video never shows the login form and the very first paint is already dark.
async function ownerState(browser, base) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/admin/login`);
  await page.fill('#a-email', ADMIN.email);
  await page.fill('#a-password', ADMIN.password);
  await Promise.all([page.waitForURL(`${base}/admin`), page.click('button[type="submit"]')]);
  await page.evaluate(() => window.localStorage.setItem('vb-theme', 'dark'));
  const state = await ctx.storageState();
  await ctx.close();
  return state;
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
      transition: 'transform 420ms cubic-bezier(0.22, 0.61, 0.36, 1)',
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
      },
      true,
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
}

// ------------------------------------------------------------------ capture clock
// Screencast frames are kept with their wall time; while the clock is paused, frames are
// dropped and the paused time is cut from the video.
class Recorder {
  constructor(page, dir, size) {
    this.page = page;
    this.dir = dir;
    this.size = size;
    this.frames = []; // { file, t } t = wall seconds
    this.pauses = []; // [startWall, endWall]
    this.pausedAt = null;
    this.t0 = null;
    this.tEnd = null;
    this.pos = { x: 40, y: 40 };
  }

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const t = (metadata && metadata.timestamp) || Date.now() / 1000;
      if (this.t0 === null || this.isPaused(t)) return;
      const file = path.join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      this.frames.push({ file, t });
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
  }

  isPaused(t) {
    if (this.pausedAt !== null && t >= this.pausedAt) return true;
    return this.pauses.some(([a, b]) => t >= a && t < b);
  }

  /** Begin the video now (everything before is setup). */
  begin() {
    this.t0 = Date.now() / 1000;
  }

  pause() {
    if (this.pausedAt === null) this.pausedAt = Date.now() / 1000;
  }

  async resume() {
    if (this.pausedAt === null) return;
    this.pauses.push([this.pausedAt, Date.now() / 1000]);
    this.pausedAt = null;
    await this.freshFrame();
  }

  // A static page sends no frames; nudge the cursor overlay so the first frame after a cut
  // shows the new state, not the last one before the pause.
  async freshFrame() {
    const n = this.frames.length;
    this.pos.x += 0.5;
    await this.page.mouse.move(this.pos.x, this.pos.y);
    for (let i = 0; i < 30 && this.frames.length === n; i += 1) await this.page.waitForTimeout(50);
  }

  /** Video time (seconds) for a wall time. */
  vt(wall = Date.now() / 1000) {
    let cut = 0;
    for (const [a, b] of this.pauses) if (wall >= b) cut += b - a;
    if (this.pausedAt !== null && wall >= this.pausedAt) cut += wall - this.pausedAt;
    return Math.max(0, wall - this.t0 - cut);
  }

  lastFrame() {
    return this.frames[this.frames.length - 1];
  }

  async stop() {
    await this.page.waitForTimeout(150);
    this.tEnd = Date.now() / 1000;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  /**
   * ffmpeg concat list: every kept frame with how long it stays on screen. `warp` maps
   * capture time to output time (scenes sped up to fit the length budget).
   */
  concatList(warp = (t) => t) {
    const kept = this.frames.filter((f) => f.t >= this.t0);
    const times = kept.map((f) => warp(this.vt(f.t)));
    const end = warp(this.vt(this.tEnd));
    const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
    const lines = [];
    kept.forEach((f, i) => {
      const dur = Math.max(0.001, (i + 1 < kept.length ? times[i + 1] : end) - times[i]);
      lines.push(`file '${esc(f.file)}'`, `duration ${dur.toFixed(4)}`);
    });
    if (kept.length) lines.push(`file '${esc(kept[kept.length - 1].file)}'`);
    return { text: lines.join('\n') + '\n', frames: kept.length, duration: end };
  }
}

// ------------------------------------------------------------------ director
function director(page, rec) {
  const pause = (ms) => page.waitForTimeout(Math.min(ms, MAX_HOLD));

  // Wait (off camera) until reveal animations and visible images have finished.
  const calm = (ms = 2500) =>
    page
      .waitForFunction(
        () => {
          const g = window.gsap;
          const busy = g
            ? g.globalTimeline
                .getChildren(true, true, false)
                .some((t) => t.isActive() && t.repeat() !== -1)
            : false;
          const imgs = Array.from(document.images).every((i) => {
            const r = i.getBoundingClientRect();
            const shown = r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
            return !shown || i.complete;
          });
          const loadingSlots = document.querySelector('[data-slots].is-loading');
          return !busy && imgs && !loadingSlots;
        },
        null,
        { timeout: ms, polling: 100 },
      )
      .catch(() => {});

  const offCamera = async (fn) => {
    rec.pause();
    try {
      await fn();
      await calm();
    } finally {
      await rec.resume();
    }
  };

  // Steady eased scroll on requestAnimationFrame (ScrollSmoother follows on desktop).
  const scrollToY = (y, ms) =>
    page.evaluate(
      ({ y: target, ms: dur }) =>
        new Promise((resolve) => {
          const root = document.documentElement;
          root.style.scrollBehavior = 'auto';
          const start = window.scrollY;
          const to = Math.max(0, Math.min(target, root.scrollHeight - window.innerHeight));
          const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2; // sine in-out: no lurch
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
        const sm = window.Site && window.Site.smoother;
        return (
          (sm ? sm.offset(el, 'top top') : el.getBoundingClientRect().top + window.scrollY) - off
        );
      },
      { selector, offset },
    );

  const scrollTo = async (selector, { offset = 0, ms = 1100 } = {}) => {
    const y = await yOf(selector, offset);
    if (y !== null) await scrollToY(y, ms);
    await offCamera(async () => {}); // let the section's reveals finish off camera
  };

  const scrollBy = async (dy, ms = 900) => {
    const y = await page.evaluate(() => window.scrollY);
    await scrollToY(y + dy, ms);
  };

  // Scroll only when the target is really out of view (or under the phone's bottom bar),
  // measuring everything in one round trip.
  const reveal = async (locator) => {
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    const m = await locator.evaluate((el) => {
      let pinned = false;
      for (let n = el; n && !pinned; n = n.parentElement) {
        const p = window.getComputedStyle(n).position;
        pinned = p === 'fixed' || p === 'sticky';
      }
      const r = el.getBoundingClientRect();
      const sm = window.Site && window.Site.smoother;
      const docTop = sm ? sm.offset(el, 'top top') : r.top + window.scrollY;
      return {
        pinned,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        h: r.height,
        docTop,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    if (m.pinned) return;
    if (m.top < 4 || m.bottom > m.vh * 0.86) {
      await scrollToY(m.docTop - (m.vh / 2 - m.h / 2), 380);
    }
    if (m.left < 0 || m.right > m.vw) await locator.scrollIntoViewIfNeeded(); // date/barber strips
  };

  // The dot glides by CSS transition (420 ms) wherever the mouse jumps, so every glide looks
  // the same at any capture resolution; wait for it to land before clicking.
  const GLIDE = 430;
  const moveTo = async (locator) => {
    await reveal(locator);
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 2 });
    rec.pos = { x, y };
    await page.waitForTimeout(GLIDE);
  };

  // Cheap readiness: visible and not disabled (Playwright's "stable" check waits on rendered
  // frames, which are slow while a large screencast runs).
  const ready = (locator) =>
    locator.evaluate(
      (el) =>
        new Promise((resolve, reject) => {
          const t0 = performance.now();
          const check = () => {
            const ok = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
            if (ok) return resolve();
            if (performance.now() - t0 > 8000) return reject(new Error('element stayed disabled'));
            return setTimeout(check, 50);
          };
          check();
        }),
    );

  const click = async (locator, { after = 300 } = {}) => {
    const t0 = rec.vt();
    await moveTo(locator);
    const t1 = rec.vt();
    await ready(locator);
    const t2 = rec.vt();
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
    if (debug)
      console.log(
        `  [t ${t0.toFixed(1)}] click ${String(locator).slice(0, 60)} · move ${(t1 - t0).toFixed(2)}s · ready ${(t2 - t1).toFixed(2)}s`,
      );
    if (after) await pause(after);
  };

  // A quick "paste" for phone numbers: click the field, then fill (typing every digit is slow).
  const fill = async (locator, text) => {
    await click(locator, { after: 60 });
    await locator.fill(text);
    await pause(150);
  };

  const type = async (locator, text) => {
    await click(locator, { after: 60 });
    await page.keyboard.type(text); // each key is a round trip already; no extra delay
  };

  return { pause, calm, offCamera, scrollTo, scrollBy, scrollToY, moveTo, click, type, fill };
}

// The step's submit: in the page on wide screens, in the sticky total bar on phones.
const nextButton = (page) =>
  page
    .locator('#step-form button[type="submit"], button[type="submit"][form="step-form"]')
    .filter({ visible: true })
    .first();

// Press the step's submit; the page load happens off camera. If the press didn't register
// (bottom bar still settling) fall back to a direct click; if the browser dropped the
// redirect under load, follow it.
async function next(page, d, rec, urlRe) {
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
    for (let w = 0; !posted && w < 3000; w += 100) await page.waitForTimeout(100);
    if (!posted) await nextButton(page).click();
    await d.offCamera(async () => {
      try {
        await page.waitForURL(urlRe, { timeout: 10000 });
      } catch (err) {
        if (!redirect || !urlRe.test(redirect)) throw err;
        await page.goto(new URL(redirect, page.url()).toString(), { waitUntil: 'load' });
      }
      await page.waitForLoadState('load');
    });
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

const lagosDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', {
    timeZone: 'Africa/Lagos',
  });

// First date from minDate with free times, then a time near the top of the list.
async function pickDateAndTime(page, d, { minDate }) {
  const chips = page.locator('a.date-chip[data-date-link]');
  const count = await chips.count();
  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    const date = await chip.getAttribute('data-date-link');
    if (date < minDate) continue;
    await d.click(chip, { after: 0 });
    await d.offCamera(async () => {}); // slot fetch off camera
    const slots = page.locator('[data-slots] label.slot');
    const n = await slots.count();
    if (!n) continue;
    await d.click(slots.nth(Math.min(2, n - 1)), { after: 250 });
    await page.waitForFunction(
      () => document.querySelector('[data-slots] input[name="startsAt"]:checked'),
      null,
      { timeout: 3000 },
    );
    return date;
  }
  throw new Error(`No free times from ${minDate} in the date strip.`);
}

/** mulberry32: small seeded PRNG so the theme pattern is varied but reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which scene starts get a theme switch: 4 of the 7 transitions (an even count, so the
 * video starts and ends dark), chosen by DEMO_SEED.
 */
function themePlan(sceneCount, seed) {
  const rand = rng(seed);
  const transitions = Array.from({ length: sceneCount - 1 }, (_, i) => i + 1);
  for (let i = transitions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [transitions[i], transitions[j]] = [transitions[j], transitions[i]];
  }
  return new Set(transitions.slice(0, 4));
}

// ------------------------------------------------------------------ scenes
function scenes({ page, d, rec, base, desktop, ids }) {
  const go = (p, { then } = {}) =>
    d.offCamera(async () => {
      await page.goto(`${base}${p}`, { waitUntil: 'load' });
      if (then) await then();
    });
  const state = {};

  return [
    {
      name: 'hero',
      budget: 6,
      async run() {
        // The intro loader (desktop) and hero entrance play on camera; the load does not.
        await d.offCamera(() => page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }));
        await d.pause(desktop ? 1500 : 1400);
        await d.pause(desktop ? 1500 : 1400);
        if (desktop) await d.pause(1100);
        else {
          await d.moveTo(page.locator('[data-hero] h1'));
          await d.pause(700);
        }
        await d.moveTo(page.locator('[data-hero] .btn-primary').first());
        await d.pause(900);
      },
    },
    {
      name: 'services',
      budget: 6,
      async run() {
        await d.scrollTo('#services', { offset: desktop ? 40 : 10, ms: 1200 });
        const tabs = page.locator('#services button.tab[data-filter]');
        if ((await tabs.count()) > 2) {
          await d.click(tabs.nth(1), { after: 900 });
          await d.click(tabs.nth(2), { after: 900 });
        }
      },
    },
    {
      name: 'shop booking',
      budget: 14,
      async run() {
        await go('/book');
        await d.click(page.locator('label.choice:has(input[name="type"][value="SHOP"])'), {
          after: 150,
        });
        await next(page, d, rec, /\/book\/services/);
        await d.click(page.locator('label:has(input[data-name="Skin Fade"])'), { after: 150 });
        await d.click(page.locator('label:has(input[data-name="Beard Trim & Line-up"])'), {
          after: 350,
        });
        await next(page, d, rec, /\/book\/time/);
        await d.click(page.locator('a.barber-chip', { hasText: 'Uche' }), { after: 0 });
        await d.offCamera(async () => {});
        await pickDateAndTime(page, d, { minDate: lagosDate(1) });
        await next(page, d, rec, /\/book\/details/);
        await d.type(page.locator('#f-name'), 'Kunle Adebanjo');
        await d.fill(page.locator('#f-phone'), '0803 000 0091');
        await d.fill(page.locator('#f-email'), 'kunle@example.com');
        await next(page, d, rec, /\/book\/confirmed/);
        await d.pause(1300); // "You're booked" + "We've emailed your confirmation to…"
      },
    },
    {
      name: 'home visit',
      budget: 10,
      async run() {
        await go('/book');
        await d.click(page.locator('label.choice:has(input[name="type"][value="HOME"])'), {
          after: 200,
        });
        await d.click(page.locator('label:has(input[data-zone-name="Lekki"])'), { after: 550 });
        await next(page, d, rec, /\/book\/services/);
        await d.click(page.locator('label:has(input[data-name="Classic Haircut"])'), {
          after: 550,
        }); // total shows service + travel fee
        await next(page, d, rec, /\/book\/time/);
        state.homeDate = await pickDateAndTime(page, d, { minDate: lagosDate(2) });
        await next(page, d, rec, /\/book\/details/);
        await d.type(page.locator('#f-name'), 'Chidera Nwankwo');
        await d.fill(page.locator('#f-phone'), '0803 000 0092');
        await d.fill(page.locator('#f-email'), 'chidera@example.com');
        await d.fill(page.locator('#f-address'), '15 Admiralty Way, Lekki');
        await next(page, d, rec, /\/book\/confirmed/);
        await d.pause(1200);
      },
    },
    {
      name: 'admin today',
      budget: 8,
      async run() {
        await go('/admin');
        await d.pause(900);
        const confirm = page
          .locator('article.a-booking', { hasText: 'Chidera Nwankwo' })
          .getByRole('button', { name: 'Confirm', exact: true })
          .first();
        await d.moveTo(confirm);
        await d.pause(200);
        // Confirm posts and the admin goes back to Today with "Booking confirmed".
        const posted = page.waitForResponse(
          (r) => r.request().method() === 'POST' && /\/admin\/bookings\/\d+\/status$/.test(r.url()),
        );
        const reloaded = page.waitForEvent('load', { timeout: 20000 }); // the redirect's page
        await d.click(confirm, { after: 0 });
        let bookingPath = null;
        await d.offCamera(async () => {
          const r = await posted;
          bookingPath = new URL(r.url()).pathname.replace(/\/status$/, '');
          await reloaded;
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        });
        await d.pause(1100); // flash: "Booking confirmed."
        // The booking itself: confirmed, address, travel fee, and the messages (owner alert).
        await go(bookingPath);
        await d.pause(900);
        await d.scrollBy(desktop ? 380 : 520, 900);
        await d.pause(600);
      },
    },
    {
      name: 'calendar',
      budget: 5,
      async run() {
        await go(`/admin/calendar?date=${state.homeDate}&barber=${ids.homeBarber}`);
        await d.pause(1100);
        await d.moveTo(page.locator('.cal-event.cal-home').first());
        await d.pause(1100);
        await d.moveTo(page.locator('.cal-buffer').first()); // travel time either side
        await d.pause(900);
      },
    },
    {
      name: 'reports',
      budget: 4,
      async run() {
        await go('/admin/reports?preset=30d');
        await d.pause(700);
        await d.scrollBy(desktop ? 650 : 900, 1100);
        await d.pause(700);
      },
    },
    {
      name: 'promo',
      budget: 4,
      async run() {
        await go('/', {
          then: async () => {
            // home.js finishes its setup with a ScrollTrigger refresh; jump only after that,
            // or the refresh puts the page back at the top.
            await page
              .waitForSelector('html[data-motion-ready]', { state: 'attached', timeout: 15000 })
              .catch(() => {}); // reduced motion: no GSAP setup, nothing to wait for
            await page.evaluate(() => {
              const el = document.querySelector('#built-by');
              const sm = window.Site && window.Site.smoother;
              const y =
                (sm ? sm.offset(el, 'top top') : el.getBoundingClientRect().top + window.scrollY) -
                40;
              if (sm) sm.scrollTo(y, false);
              else window.scrollTo({ top: y, behavior: 'instant' });
            });
            await page.waitForTimeout(700); // ScrollSmoother settles before we measure the CTA
          },
        });
        const cta = page.locator('#built-by a', { hasText: /website like this/i }).first();
        await d.moveTo(cta);
        await d.pause(1500);
        await d.pause(1200);
      },
    },
  ];
}

async function switchTheme(page, d) {
  const toggles = page.locator('[data-theme-toggle]').filter({ visible: true });
  const vp = page.viewportSize();
  for (let i = 0; i < (await toggles.count()); i += 1) {
    const t = toggles.nth(i);
    const b = await t.boundingBox();
    if (b && b.y >= 0 && b.x >= 0 && b.y + b.height <= vp.height && b.x + b.width <= vp.width) {
      const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await d.click(t, { after: 0 });
      await d.pause(850); // the circular theme reveal (750 ms) plays out
      const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      return { from: before, to: after };
    }
  }
  throw new Error('No theme toggle visible in the header.');
}

// ------------------------------------------------------------------ length budget
const TARGET_SECONDS = 57;
const MAX_SPEED = 1.6;

/**
 * Pure: per-scene playback speeds. Real time when the take fits (≤ 59.5 s); otherwise the
 * time to cut is shared among scenes in proportion to how far each ran over its budget.
 */
function speedPlan(timeline, target = TARGET_SECONDS) {
  const lens = timeline.map((t) => t.end - t.start);
  const total = lens.reduce((a, b) => a + b, 0);
  if (total <= target + 2.5) return timeline.map(() => 1);
  const over = timeline.map((t, i) => Math.max(0, lens[i] - t.budget));
  const overSum = over.reduce((a, b) => a + b, 0);
  const cut = total - target;
  return lens.map((len, i) => {
    const share = overSum ? (cut * over[i]) / overSum : (cut * len) / total;
    return Math.min(MAX_SPEED, len / Math.max(0.1, len - share));
  });
}

/** Pure: capture time → output time, given each scene's [start, end] and speed. */
function warper(timeline, speeds) {
  return (v) => {
    let out = 0;
    for (const [i, t] of timeline.entries()) {
      if (v >= t.end) out += (t.end - t.start) / speeds[i];
      else {
        if (v > t.start) out += (v - t.start) / speeds[i];
        return out;
      }
    }
    return out + (v - timeline[timeline.length - 1].end); // after the last scene: real time
  };
}

// ------------------------------------------------------------------ one format
async function record(browser, name, { base, ids, storageState, plan }) {
  const f = FORMATS[name];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vb-${name}-`));
  const context = await browser.newContext({
    viewport: f.viewport,
    deviceScaleFactor: f.deviceScaleFactor,
    isMobile: f.isMobile,
    hasTouch: f.hasTouch,
    userAgent: f.userAgent,
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    storageState,
  });
  await context.addInitScript(cursorOverlay);
  const page = await context.newPage();
  if (debug) {
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
    page.on('response', (r) => {
      if (r.request().method() === 'POST')
        console.log(`  [POST] ${r.url().replace(base, '')} → ${r.status()}`);
    });
  }
  const rec = new Recorder(page, dir, f.size);
  await rec.start();
  const d = director(page, rec);
  const list = scenes({ page, d, rec, base, desktop: name === 'landscape', ids });
  const timeline = [];
  const segments = []; // for the length budget: scene bodies + real-time theme switches
  const switches = [];
  const stills = [];

  try {
    rec.begin();
    for (const [i, scene] of list.entries()) {
      const start = rec.vt();
      let bodyStart = start;
      if (plan.has(i)) {
        // Switch on a settled page at the scene start: never mid-form or mid-scroll. Scenes
        // that open with a navigation load it first (off camera), then switch.
        if (['shop booking', 'home visit'].includes(scene.name)) {
          await d.offCamera(() => page.goto(`${base}/book`, { waitUntil: 'load' }));
        } else if (scene.name === 'admin today') {
          await d.offCamera(() => page.goto(`${base}/admin`, { waitUntil: 'load' }));
        }
        const at = rec.vt();
        const s = await switchTheme(page, d);
        bodyStart = rec.vt();
        switches.push({ at, scene: scene.name, ...s });
        // Its own segment, budgeted at its length, so it always plays in real time.
        segments.push({ start: at, end: bodyStart, budget: bodyStart - at });
      }
      await scene.run();
      const end = rec.vt();
      timeline.push({ scene: scene.name, start, end, budget: scene.budget });
      segments.push({
        start: bodyStart,
        end,
        budget: Math.max(1, scene.budget - (bodyStart - start)),
      });
      const last = rec.lastFrame();
      if (last) stills.push({ scene: scene.name, i, file: last.file });
    }
    await rec.stop();
  } catch (err) {
    const shot = path.join(OUT, `error-${name}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    err.message += `\n  (screenshot: ${shot})`;
    await rec.stop().catch(() => {});
    await context.close();
    throw err;
  }
  await context.close();

  // Fit the length budget: if the take ran long (this machine's speed varies), play the
  // over-budget scenes slightly faster; everything else stays real time.
  // Theme switches are their own segments, so they're never sped up.
  const speeds = speedPlan(segments);
  const warp = warper(segments, speeds);
  for (const t of timeline) {
    const body = segments.findIndex((sg) => sg.end === t.end);
    t.speed = speeds[body];
    t.start = warp(t.start);
    t.end = warp(t.end);
  }
  for (const s of switches) s.at = warp(s.at);

  // Stills: the last frame of each scene, at full resolution.
  fs.mkdirSync(STILLS, { recursive: true });
  for (const s of stills) {
    const slug = s.scene.replace(/\s+/g, '-');
    fs.copyFileSync(
      s.file,
      path.join(STILLS, `${name}-${String(s.i + 1).padStart(2, '0')}-${slug}.jpg`),
    );
  }

  // Encode: timed frames → constant 30 fps H.264.
  const { text, frames, duration } = rec.concatList(warp);
  const listFile = path.join(dir, 'frames.txt');
  fs.writeFileSync(listFile, text);
  const mp4 = path.join(OUT, `${f.file}.mp4`);
  const enc = spawnSync(
    FFMPEG,
    [
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-vf',
      `fps=30,scale=${f.size.width}:${f.size.height}:flags=lanczos,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-profile:v',
      'high',
      '-r',
      '30',
      '-movflags',
      '+faststart',
      mp4,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr}`);
  const outputs = [mp4];
  if (webm) {
    const wf = path.join(OUT, `${f.file}.webm`);
    const w = spawnSync(
      FFMPEG,
      [
        '-y',
        '-v',
        'error',
        '-i',
        mp4,
        '-c:v',
        'libvpx-vp9',
        '-crf',
        '32',
        '-b:v',
        '0',
        '-row-mt',
        '1',
        wf,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    if (w.status === 0) outputs.push(wf);
    else console.warn(`WebM encode failed: ${w.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, outputs, mp4, frames, duration, timeline, switches, size: f.size };
}

// ------------------------------------------------------------------ checks + report
function probe(mp4) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', mp4], { encoding: 'utf8' });
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  const vid = /Video: h264[^\n]*?, (\d{3,4})x(\d{3,4})[^\n]*?, ([\d.]+) fps/.exec(r.stderr);
  return {
    seconds: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : null,
    width: vid ? +vid[1] : null,
    height: vid ? +vid[2] : null,
    fps: vid ? +vid[3] : null,
    pixfmt: /yuv420p/.test(r.stderr),
  };
}

// The old bug: the page drawn into the top-left quarter of a grey canvas. Check the right
// and bottom edges of the first and last frames aren't a flat grey band.
function greyBorder(mp4, { width, height }, which) {
  const input = which === 'last' ? ['-sseof', '-0.3', '-i', mp4] : ['-i', mp4];
  const r = spawnSync(
    FFMPEG,
    ['-v', 'error', ...input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: width * height * 3 + 1024 },
  );
  const buf = r.stdout;
  if (!buf || buf.length < width * height * 3) return { ok: false, why: 'could not read frame' };
  const px = (x, y) => {
    const o = (y * width + x) * 3;
    return [buf[o], buf[o + 1], buf[o + 2]];
  };
  const flatGrey = (pts) => {
    const grey = pts.filter(
      ([r, g, b]) => Math.abs(r - g) < 4 && Math.abs(g - b) < 4 && r > 60 && r < 235,
    );
    if (grey.length < pts.length * 0.97) return false;
    const mean = grey.reduce((s, p) => s + p[0], 0) / grey.length;
    return grey.every((p) => Math.abs(p[0] - mean) < 3);
  };
  const right = [];
  const bottom = [];
  for (let y = 0; y < height; y += 4)
    for (let x = width - 6; x < width; x += 2) right.push(px(x, y));
  for (let x = 0; x < width; x += 4)
    for (let y = height - 6; y < height; y += 2) bottom.push(px(x, y));
  const bad = flatGrey(right) || flatGrey(bottom);
  return { ok: !bad, why: bad ? 'flat grey band at the edge' : 'edges carry page content' };
}

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function report(res) {
  const p = probe(res.mp4);
  const first = greyBorder(res.mp4, res.size, 'first');
  const last = greyBorder(res.mp4, res.size, 'last');
  console.log(`\n${res.name.toUpperCase()}  ${res.mp4}`);
  console.log(
    `  ${p.width}×${p.height} · ${p.fps} fps · ${p.pixfmt ? 'yuv420p' : '?'} · ${p.seconds != null ? p.seconds.toFixed(1) : '?'} s` +
      ` (captured ${res.frames} frames, ~${(res.frames / res.duration).toFixed(0)} unique fps)`,
  );
  console.log(
    `  grey border: first frame ${first.ok ? 'none' : 'FOUND'} (${first.why}); last frame ${last.ok ? 'none' : 'FOUND'} (${last.why})`,
  );
  console.log('  scenes:');
  for (const t of res.timeline) {
    const len = t.end - t.start;
    console.log(
      `    ${fmt(t.start)}–${fmt(t.end)}  ${t.scene.padEnd(13)} ${len.toFixed(1)} s (plan ${t.budget} s)` +
        (t.speed > 1.005 ? ` · played at ${t.speed.toFixed(2)}×` : ''),
    );
  }
  console.log('  theme switches:');
  for (const s of res.switches)
    console.log(`    ${fmt(s.at)}  ${s.from} → ${s.to}  (start of ${s.scene})`);
  for (const o of res.outputs.slice(1)) console.log(`  also: ${o}`);
  return p;
}

// ------------------------------------------------------------------ main
async function main() {
  const names = only ? [only] : ['vertical', 'landscape'];
  if (names.some((n) => !FORMATS[n])) throw new Error('--only must be vertical or landscape.');
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(STILLS, { recursive: true, force: true }); // stills always match this run
  const port = await pickPort();
  const base = `http://localhost:${port}`;

  const db = demoDatabaseUrl();
  const env = {
    ...process.env,
    DATABASE_URL: db.url,
    NODE_ENV: 'development',
    PORT: String(port),
    APP_URL: base,
    DEMO_MODE: '1', // no launch checklist or other setup-only UI
    NOTIFY_MODE: 'log', // nothing is ever sent from a demo run
    NOTIFY_ALLOWLIST: '',
    OWNER_EMAIL: '', // owner alerts go to the demo shop email (log only)
    TERMII_API_KEY: '', // SMS off: email is the customer channel (and required)
    TERMII_SENDER_ID: '',
    SMS_ENABLED: '',
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
  const ids = { homeBarber: await barberIdBySlug(db.url, 'uche') };

  console.log(`Starting the app on ${base} (DEMO_MODE=1, NOTIFY_MODE=log)…`);
  const server = await startServer(env, base);
  const browser = await chromium.launch({ headless: !headed });
  const results = [];
  try {
    const storageState = await ownerState(browser, base);
    const sceneCount = 8;
    const plan = themePlan(sceneCount, SEED);
    console.log(
      `Theme: starts dark; switches at the start of scenes ${[...plan]
        .sort()
        .map((i) => i + 1)
        .join(', ')} (DEMO_SEED=${SEED}).`,
    );
    for (const name of names) {
      console.log(`Recording ${name}…`);
      results.push(await record(browser, name, { base, ids, storageState, plan }));
    }
  } finally {
    await browser.close();
    server.kill();
  }

  for (const r of results) report(r);
  console.log(`\nStills: ${STILLS}`);
  for (const f of fs.readdirSync(STILLS).sort()) console.log(`  ${f}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
