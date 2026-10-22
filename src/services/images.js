// Admin image uploads: decode with sharp, write each responsive width as WebP under
// public/uploads/<kind>/, and return the base path (`/uploads/<kind>/<name>`), matching the
// `${base}-${width}.webp` convention the views use (see docs/ARCHITECTURE.md).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { ValidationError } = require('../lib/errors');

// We only ever decode buffers; libvips' file cache would hold Windows file handles open
// and block deleting replaced images.
sharp.cache(false);

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Widths each kind of image is rendered at (must match the views' srcset calls).
const WIDTHS = {
  services: [500, 900],
  barbers: [500, 900],
  products: [400, 800],
  gallery: [600, 1200],
};
const MIN_WIDTH = 400; // smaller uploads look soft on phones
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff']);

const slugPart = (s) =>
  String(s || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';

/**
 * Process an uploaded image buffer. Returns the base URL to store in the database.
 * Throws ValidationError for files that aren't images or are too small.
 */
async function saveUpload(buffer, { kind, name, root = PUBLIC_DIR }) {
  const widths = WIDTHS[kind];
  if (!widths) throw new Error(`Unknown image kind: ${kind}`);
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new ValidationError('That file isn’t an image we can read. Use a JPG, PNG or WebP.', [
      { path: 'image', message: 'Not an image' },
    ]);
  }
  if (!ALLOWED.has(meta.format)) {
    throw new ValidationError('Use a JPG, PNG or WebP image.', [
      { path: 'image', message: 'Unsupported format' },
    ]);
  }
  // EXIF orientation can swap width and height.
  const shortSide = Math.min(meta.width || 0, meta.height || 0);
  const wide = meta.orientation >= 5 ? meta.height : meta.width;
  if (!wide || wide < MIN_WIDTH || shortSide < 200) {
    throw new ValidationError(`Image is too small. Use one at least ${MIN_WIDTH} px wide.`, [
      { path: 'image', message: 'Too small' },
    ]);
  }

  const dir = path.join(root, 'uploads', kind);
  await fs.mkdir(dir, { recursive: true });
  const base = `${slugPart(name)}-${crypto.randomBytes(4).toString('hex')}`;
  await Promise.all(
    widths.map((w) =>
      sharp(buffer)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(dir, `${base}-${w}.webp`)),
    ),
  );
  return `/uploads/${kind}/${base}`;
}

/** Delete the files behind a base URL. Only ever touches files we created under /uploads/. */
async function removeUpload(baseUrl, { kind, root = PUBLIC_DIR }) {
  if (!baseUrl || !baseUrl.startsWith(`/uploads/${kind}/`)) return;
  const name = path.basename(baseUrl);
  if (!/^[a-z0-9-]+$/.test(name)) return;
  await Promise.all(
    WIDTHS[kind].map((w) =>
      fs.rm(path.join(root, 'uploads', kind, `${name}-${w}.webp`), { force: true }),
    ),
  );
}

module.exports = { saveUpload, removeUpload, WIDTHS, MIN_WIDTH };
