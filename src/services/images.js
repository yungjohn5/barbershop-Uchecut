// Image uploads to Cloudinary. multer keeps the file in memory (8 MB cap, middleware/upload.js);
// here the real type is checked from its bytes, then it is streamed to
// `{CLOUDINARY_FOLDER}/{kind}`. The database stores only { publicId, version, width, height };
// views build f_auto,q_auto URLs (lib/images.js). The API secret never leaves the server.
const { v2: cloudinary } = require('cloudinary');
const env = require('../config/env');
const logger = require('../lib/logger');
const { ValidationError } = require('../lib/errors');
const { detectImageType } = require('../lib/fileType');

if (env.CLOUDINARY_URL) cloudinary.config({ secure: true }); // reads CLOUDINARY_URL

const KINDS = ['services', 'barbers', 'products', 'gallery', 'site'];
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_WIDTH = 400; // smaller looks soft on phones

const invalid = (message) => new ValidationError(message, [{ path: 'image', message }]);
const slug = (s) =>
  String(s || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';

function uploadStream(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) =>
      err ? reject(err) : resolve(result),
    );
    stream.end(buffer);
  });
}

// Deletes run in the background; tests (and graceful shutdown) can await them.
const pending = new Set();

/** Delete an image from Cloudinary. Never throws: failures are logged. */
async function destroyImage(publicId) {
  if (!publicId || !env.CLOUDINARY_URL) return false;
  try {
    const res = await cloudinary.uploader.destroy(publicId, { invalidate: true });
    if (res && res.result !== 'ok' && res.result !== 'not found') throw new Error(res.result);
    return true;
  } catch (err) {
    logger.warn({ publicId, err: err.message || String(err) }, 'cloudinary destroy failed');
    return false;
  }
}

/** Fire-and-forget delete (doesn't hold up the request). */
function destroyLater(publicId) {
  if (!publicId) return;
  const p = destroyImage(publicId).finally(() => pending.delete(p));
  pending.add(p);
}
const settled = () => Promise.all([...pending]);

/**
 * Validate and upload. Returns { publicId, version, width, height }.
 * Throws ValidationError (shown on the form) for bad files or a failed upload.
 */
async function uploadImage(buffer, { kind, name }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown image kind: ${kind}`);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw invalid('Choose a photo to upload.');
  if (buffer.length > MAX_BYTES) throw invalid('Image must be 8 MB or smaller.');
  if (!detectImageType(buffer))
    throw invalid('That file isn’t an image we can read. Use a JPG, PNG or WebP.');
  if (!env.CLOUDINARY_URL)
    throw invalid('Photo uploads aren’t set up yet (CLOUDINARY_URL is missing).');

  let result;
  try {
    result = await uploadStream(buffer, {
      folder: `${env.CLOUDINARY_FOLDER}/${kind}`,
      public_id: `${slug(name)}-${Date.now().toString(36)}`,
      resource_type: 'image',
      overwrite: false,
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    });
  } catch (err) {
    logger.error({ kind, err: err.message || String(err) }, 'cloudinary upload failed');
    throw invalid('Couldn’t upload the photo. Please try again.');
  }
  if (!result.width || result.width < MIN_WIDTH || result.height < 200) {
    destroyLater(result.public_id);
    throw invalid(`Image is too small. Use one at least ${MIN_WIDTH} px wide.`);
  }
  return {
    publicId: result.public_id,
    version: result.version,
    width: result.width,
    height: result.height,
  };
}

/** DB fields for an uploaded image on a record ('image' → imagePublicId… and clears legacy). */
function fieldsFor(field, uploaded) {
  const cap = field[0].toUpperCase() + field.slice(1);
  return {
    [`${field}PublicId`]: uploaded.publicId,
    [`${field}Version`]: uploaded.version,
    [`${field}Width`]: uploaded.width,
    [`${field}Height`]: uploaded.height,
    [`legacy${cap}Path`]: null,
  };
}

module.exports = {
  KINDS,
  MAX_BYTES,
  MIN_WIDTH,
  uploadImage,
  destroyImage,
  destroyLater,
  settled,
  fieldsFor,
};
