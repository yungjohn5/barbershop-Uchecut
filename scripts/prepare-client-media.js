// Polish the client's own media (media/client/) into web-ready files in public/:
//   logos   → public/images/brand/{mark,logo}.{png,webp}, public/icons/*, public/images/og-default.jpg
//             (gold-on-black JPEGs keyed to transparent; icons and share card on solid black)
//   photos  → public/images/client/<id>-<width>.webp   (src/config/media.js PHOTOS)
//   videos  → public/media/reels/<id>.mp4 + <id>-poster.webp   (src/config/media.js REELS)
// Photos and videos get one grade: the shop's blue-violet fluorescent cast warmed out, a little
// contrast and depth, light sharpening. Videos: upright 540×960, H.264 + AAC, +faststart.
//
//   npm run media:prepare                 everything
//   npm run media:prepare -- --only=brand  brand | photos | videos
/* global Image, document -- page.evaluate body runs in the browser */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const FFMPEG = require('ffmpeg-static');
const { chromium } = require('playwright');
const { REELS, PHOTOS } = require('../src/config/media');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'media', 'client');
const PUBLIC = path.join(ROOT, 'public');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const GRADE = [
  'colortemperature=temperature=4700:mix=0.75:pl=0.6',
  'colorbalance=rs=0.03:bs=-0.05:bm=-0.04:bh=-0.03',
  'eq=contrast=1.1:saturation=1.04:gamma=0.96',
].join(',');

/** Clip length in seconds (ffmpeg prints it on stderr for any input). */
function durationOf(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
}

const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;

// ------------------------------------------------------------------ logos
async function brand() {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const base = 'file:///' + path.join(SRC, 'logos').replace(/\\/g, '/');
  await page.goto(base + '/');
  const out = await page.evaluate(
    async ({ src }) => {
      const load = async (f) => {
        const i = new Image();
        i.src = `${src}/${f}`;
        await i.decode();
        return i;
      };
      const board = await load('2.jpeg'); // brand board: clean emblem in the hero panel
      const badge = await load('1.jpeg'); // full badge with the name and taglines
      const canvas = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return [c, c.getContext('2d')];
      };
      // Black → transparent on a soft ramp; gold and silver stay opaque.
      const key = (ctx, w, h, lo, hi) => {
        const d = ctx.getImageData(0, 0, w, h);
        const p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          const v = Math.max(p[i], p[i + 1], p[i + 2]);
          p[i + 3] = Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 255);
        }
        ctx.putImageData(d, 0, 0);
      };
      const trim = (c) => {
        const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        let x0 = width;
        let y0 = height;
        let x1 = 0;
        let y1 = 0;
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1)
            if (data[(y * width + x) * 4 + 3] > 24) {
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x);
              y0 = Math.min(y0, y);
              y1 = Math.max(y1, y);
            }
        const pad = 4;
        x0 = Math.max(0, x0 - pad);
        y0 = Math.max(0, y0 - pad);
        x1 = Math.min(width - 1, x1 + pad);
        y1 = Math.min(height - 1, y1 + pad);
        const [o, octx] = canvas(x1 - x0 + 1, y1 - y0 + 1);
        octx.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
        return o;
      };
      const crop = (img, sx, sy, sw, sh, scale) => {
        const [c, ctx] = canvas(Math.round(sw * scale), Math.round(sh * scale));
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return [c, ctx];
      };
      const fit = (c, maxW, maxH) => {
        const k = Math.min(1, maxW / c.width, maxH / c.height);
        const [o, octx] = canvas(Math.round(c.width * k), Math.round(c.height * k));
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(c, 0, 0, o.width, o.height);
        return o;
      };
      const res = {};
      let mark;
      {
        const [c, ctx] = crop(board, 255, 30, 255, 275, 2); // crown + ring + VE + razor/clipper
        key(ctx, c.width, c.height, 26, 78);
        mark = trim(c);
        const m = fit(mark, 520, 260); // shown ≤ 64 px tall: 4× for retina
        res['images/brand/mark.png'] = m.toDataURL('image/png');
        res['images/brand/mark.webp'] = m.toDataURL('image/webp', 0.9);
        res['@mark'] = [m.width, m.height];
      }
      let logo;
      {
        const [c, ctx] = crop(badge, 40, 40, 1000, 1000, 1);
        key(ctx, c.width, c.height, 30, 85);
        logo = trim(c);
        const l = fit(logo, 720, 720); // dark surfaces only (its silver lettering needs it)
        res['images/brand/logo.png'] = l.toDataURL('image/png');
        res['images/brand/logo.webp'] = l.toDataURL('image/webp', 0.9);
        res['@logo'] = [l.width, l.height];
      }
      const icon = (size, inset) => {
        const [c, ctx] = canvas(size, size);
        ctx.fillStyle = '#0b0b0b';
        ctx.fillRect(0, 0, size, size);
        const s = size * (1 - inset * 2);
        const k = Math.min(s / mark.width, s / mark.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
          mark,
          (size - mark.width * k) / 2,
          (size - mark.height * k) / 2,
          mark.width * k,
          mark.height * k,
        );
        return c.toDataURL('image/png');
      };
      res['icons/icon-32.png'] = icon(32, 0.02);
      res['icons/icon-192.png'] = icon(192, 0.06);
      res['icons/icon-512.png'] = icon(512, 0.06);
      res['icons/icon-maskable-512.png'] = icon(512, 0.17);
      res['icons/apple-touch-icon.png'] = icon(180, 0.1);
      {
        const [c, ctx] = canvas(1200, 630);
        ctx.fillStyle = '#0b0b0b';
        ctx.fillRect(0, 0, 1200, 630);
        const k = Math.min(560 / logo.width, 580 / logo.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
          logo,
          (1200 - logo.width * k) / 2,
          (630 - logo.height * k) / 2,
          logo.width * k,
          logo.height * k,
        );
        res['images/og-default.jpg'] = c.toDataURL('image/jpeg', 0.9);
      }
      return res;
    },
    { src: base },
  );
  for (const [rel, data] of Object.entries(out)) {
    if (rel.startsWith('@')) {
      console.log(`  ${rel.slice(1)} size: ${data.join('×')}`);
      continue;
    }
    const file = path.join(PUBLIC, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log(`  ${rel} ${kb(file)}`);
  }
  // The old vector "V." favicon no longer matches the brand.
  fs.rmSync(path.join(PUBLIC, 'favicon.svg'), { force: true });
  await browser.close();
}

// ------------------------------------------------------------------ photos
function photos() {
  const dir = path.join(PUBLIC, 'images', 'client');
  fs.mkdirSync(dir, { recursive: true });
  for (const p of PHOTOS) {
    for (const w of p.widths) {
      const out = path.join(dir, `${p.id}-${w}.webp`);
      ffmpeg([
        '-i',
        path.join(SRC, 'photos', p.source),
        '-vf',
        `${GRADE},vignette=angle=PI/6,scale=${w}:-2:flags=lanczos,unsharp=5:5:0.5:5:5:0.0`,
        '-c:v',
        'libwebp',
        '-quality',
        '82',
        '-compression_level',
        '6',
        out,
      ]);
      console.log(`  ${path.relative(PUBLIC, out)} ${kb(out)}`);
    }
  }
}

// ------------------------------------------------------------------ videos
function videos() {
  const dir = path.join(PUBLIC, 'media', 'reels');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of REELS) {
    const src = path.join(SRC, 'videos', r.source);
    const mp4 = path.join(dir, `${r.id}.mp4`);
    // ffmpeg applies the phone's rotation flag itself, so every clip comes out upright.
    const vf = `${GRADE},scale=540:960:force_original_aspect_ratio=increase:flags=lanczos,crop=540:960,fps=30,format=yuv420p`;
    ffmpeg([
      '-ss',
      // Phone clips often open on a blurry close-up: take the middle unless a start is set.
      String(r.start ?? Math.max(0, (durationOf(src) - (r.seconds || 12)) / 2).toFixed(2)),
      '-t',
      String(r.seconds || 12), // reels loop: a short, strong clip beats the whole recording
      '-i',
      src,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '29',
      '-profile:v',
      'high',
      '-level',
      '4.0',
      '-maxrate',
      '1000k',
      '-bufsize',
      '2000k',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      mp4,
    ]);
    const poster = path.join(dir, `${r.id}-poster.webp`);
    ffmpeg([
      '-ss',
      String(r.posterAt ?? 3),
      '-i',
      mp4,
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      '78',
      poster,
    ]);
    console.log(`  ${path.relative(PUBLIC, mp4)} ${kb(mp4)} · poster ${kb(poster)}`);
  }
}

(async () => {
  if (!only || only === 'brand') {
    console.log('Brand (logos → mark, badge, icons, share card)…');
    await brand();
  }
  if (!only || only === 'photos') {
    console.log('Photos…');
    photos();
  }
  if (!only || only === 'videos') {
    console.log('Videos…');
    videos();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
