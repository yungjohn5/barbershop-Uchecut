// Image URLs for every view. An image is a descriptor:
//   { publicId, version, width, height }  → Cloudinary (f_auto,q_auto: WebP/AVIF as the browser allows)
//   { legacy: '/images/site/hero' }         → a bundled/older local file, `${legacy}-${width}.webp`,
//                                              used only until scripts/upload-local-images.js moves it
// Records keep `${field}PublicId|Version|Width|Height` and `legacy${Field}Path` columns;
// imageOf(record, 'image') builds the descriptor. Never needs the API secret.
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

/** Cloudinary transformation string, e.g. "f_auto,q_auto,c_fill,g_auto,w_800,h_600". */
function transform({ w, h, crop = 'fill', gravity = 'auto' } = {}) {
  const parts = ['f_auto', 'q_auto'];
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
  siteImage,
  transform,
  legacyWidths,
  SITE_SLOTS,
  DEFAULT_WIDTHS,
};
