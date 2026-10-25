// Image URLs for every view. An image is a descriptor:
//   { publicId, version, width, height }  → Cloudinary (f_auto,q_auto: WebP/AVIF as the browser allows)
//   { legacy: '/images/site/hero' }         → a bundled/older local file, `${legacy}-${width}.webp`,
//                                              used only until scripts/upload-local-images.js moves it
// Records keep `${field}PublicId|Version|Width|Height` and `legacy${Field}Path` columns;
// imageOf(record, 'image') builds the descriptor. Never needs the API secret.
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const DEFAULT_WIDTHS = [400, 800, 1200];

// Widths the bundled/legacy local files exist in (path prefix → widths).
const LEGACY_WIDTHS = [
  ['/images/site/hero', [800, 1400, 2200]],
  ['/images/site/intro-portrait', [600, 1100]],
  ['/images/site/intro-still', [400, 800]],
  ['/images/site/intro-tools', [500, 900]],
  ['/images/site/craft-portrait', [700, 1300]],
  ['/images/site/craft-', [500, 900]],
  ['/images/site/home-visit', [700, 1300]],
  ['/images/site/chair', [1000, 1800]],
  ['/images/site/barber-', [500, 900]],
  ['/images/site/ritual-', [700, 1300]],
  ['/images/site/look-', [600, 1200]],
  ['/images/site/prod-', [400, 800]],
  ['/images/site/svc-', [500, 900]],
  ['/uploads/products/', [400, 800]],
  ['/uploads/gallery/', [600, 1200]],
  ['/uploads/', [500, 900]],
];
const legacyWidths = (p) =>
  (LEGACY_WIDTHS.find(([prefix]) => p.startsWith(prefix)) || [null, [500, 900]])[1];

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Descriptor for a record's image field ('image' → imagePublicId…, legacyImagePath). */
function imageOf(record, field = 'image') {
  if (!record) return null;
  const publicId = record[`${field}PublicId`];
  if (publicId) {
    return {
      publicId,
      version: record[`${field}Version`] || null,
      width: record[`${field}Width`] || null,
      height: record[`${field}Height`] || null,
    };
  }
  const legacy = record[`legacy${cap(field)}Path`];
  return legacy ? { legacy } : null;
}

/**
 * Cloudinary transformation string, e.g. "f_auto,q_auto,c_fill,g_auto,w_800,h_600".
 * `format` pins the output (e.g. 'jpg' for social crawlers); default f_auto.
 */
function transform({ w, h, crop = 'fill', gravity = 'auto', format = 'auto' } = {}) {
  const parts = [`f_${format}`, 'q_auto'];
  if (w || h) {
    parts.push(`c_${crop}`);
    if (crop === 'fill' && h) parts.push(`g_${gravity}`);
  }
  if (w) parts.push(`w_${Math.round(w)}`);
  if (h) parts.push(`h_${Math.round(h)}`);
  return parts.join(',');
}

/** URL for an image at a size. Returns '' for a missing image. */
function imageUrl(img, opts = {}) {
  if (!img) return '';
  if (img.legacy) {
    const widths = legacyWidths(img.legacy);
    const want = opts.w || widths[widths.length - 1];
    const w = widths.find((x) => x >= want) || widths[widths.length - 1];
    return `${img.legacy}-${w}.webp`;
  }
  const cloud = env.cloudinaryCloud;
  if (!cloud) return '';
  const version = img.version ? `v${img.version}/` : '';
  return `https://res.cloudinary.com/${cloud}/image/upload/${transform(opts)}/${version}${img.publicId}`;
}

/** srcset for responsive <img>. With `ratio` (h/w), crops every width to that shape. */
function srcset(img, widths = DEFAULT_WIDTHS, { ratio, crop } = {}) {
  if (!img) return '';
  if (img.legacy)
    return legacyWidths(img.legacy)
      .map((w) => `${img.legacy}-${w}.webp ${w}w`)
      .join(', ');
  return widths
    .map((w) => `${imageUrl(img, { w, h: ratio ? Math.round(w * ratio) : undefined, crop })} ${w}w`)
    .join(', ');
}

// Intrinsic size of a bundled WebP, read from its header once (VP8, VP8L or VP8X).
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const legacySizes = new Map();
function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ')
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X')
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}
function legacySize(base) {
  if (!legacySizes.has(base)) {
    const widths = legacyWidths(base);
    let size = null;
    try {
      const fd = fs.openSync(path.join(PUBLIC_DIR, `${base}-${widths[widths.length - 1]}.webp`));
      const head = Buffer.alloc(32);
      fs.readSync(fd, head, 0, 32, 0);
      fs.closeSync(fd);
      size = webpSize(head);
    } catch {
      size = null; // file gone (e.g. an old upload): no size attributes
    }
    legacySizes.set(base, size);
  }
  return legacySizes.get(base);
}

/**
 * width/height attributes for an <img> (stops layout shift): the crop size when both are
 * given, else the requested width scaled by the image's own shape. '' when unknown.
 */
function imgSize(img, { w, h } = {}) {
  if (!img) return '';
  if (w && h) return `width="${Math.round(w)}" height="${Math.round(h)}"`;
  const own = img.legacy ? legacySize(img.legacy) : img.width && img.height ? img : null;
  if (!own) return '';
  const width = Math.round(w || own.width);
  return `width="${width}" height="${Math.round((width * own.height) / own.width)}"`;
}

/** Site photo slots (Settings → Site photos) and their bundled placeholders. */
const SITE_SLOTS = {
  hero: {
    label: 'Hero',
    legacy: '/images/site/hero',
    hint: 'Wide, dark-friendly photo. 2000 px+.',
  },
  introPortrait: { label: 'Intro: portrait', legacy: '/images/site/intro-portrait' },
  introTools: { label: 'Intro: tools', legacy: '/images/site/intro-tools' },
  introStill: { label: 'Intro: still life', legacy: '/images/site/intro-still' },
  ritualConsult: { label: 'Ritual 1: consultation', legacy: '/images/site/ritual-consult' },
  ritualCut: { label: 'Ritual 2: the cut', legacy: '/images/site/ritual-cut' },
  ritualDetail: { label: 'Ritual 3: the detail', legacy: '/images/site/ritual-detail' },
  ritualFinish: { label: 'Ritual 4: the finish', legacy: '/images/site/ritual-finish' },
  craftPortrait: { label: 'Craft: portrait', legacy: '/images/site/craft-portrait' },
  craftA: { label: 'Craft: detail 1', legacy: '/images/site/craft-a' },
  craftB: { label: 'Craft: detail 2', legacy: '/images/site/craft-b' },
  homeVisit: { label: 'Home visits', legacy: '/images/site/home-visit' },
  chair: {
    label: 'Footer “Take the chair”',
    legacy: '/images/site/chair',
    hint: 'Shows through the big letters. 1800 px+.',
  },
};

/** Descriptor for a site slot: the uploaded photo, else the bundled placeholder. */
function siteImage(slot, siteImages = {}) {
  const def = SITE_SLOTS[slot];
  if (!def) throw new Error(`Unknown site image slot: ${slot}`);
  const up = siteImages && siteImages[slot];
  return up && up.publicId ? up : { legacy: def.legacy };
}

module.exports = {
  imageOf,
  imageUrl,
  srcset,
  imgSize,
  webpSize,
  siteImage,
  transform,
  legacyWidths,
  SITE_SLOTS,
  DEFAULT_WIDTHS,
};
