// Detect an image's real type from its first bytes ("magic numbers"), never from the file
// name or the browser-supplied MIME type. Only the formats we accept are recognised.
const SIGNATURES = [
  {
    type: 'jpeg',
    mime: 'image/jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  },
  {
    type: 'webp',
    mime: 'image/webp',
    // "RIFF" <size> "WEBP"
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/** Returns { type, mime } for JPEG/PNG/WebP, or null for anything else. */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const hit = SIGNATURES.find((s) => s.test(buffer));
  return hit ? { type: hit.type, mime: hit.mime } : null;
}

module.exports = { detectImageType };
