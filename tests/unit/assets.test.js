// Performance helpers: fingerprinted asset URLs, cache headers, <img> width/height.
const { createAsset, cacheHeaders, hashOf, ONE_YEAR } = require('../../src/lib/assets');
const { imgSize, webpSize } = require('../../src/lib/images');
const path = require('path');

describe('asset fingerprints', () => {
  const asset = createAsset({ memo: false });

  test('CSS/JS URLs carry a content hash', () => {
    const css = path.join(__dirname, '..', '..', 'public', 'css', 'app.css');
    expect(asset('/css/app.css')).toBe(`/css/app.css?v=${hashOf(css)}`);
    expect(asset('/js/site.js')).toMatch(/^\/js\/site\.js\?v=[0-9a-f]{10}$/);
    expect(asset('/vendor/gsap/gsap.min.js')).toMatch(/\?v=[0-9a-f]{10}$/);
  });

  test('a missing file falls back to the plain URL', () => {
    expect(asset('/js/nope.js')).toBe('/js/nope.js');
  });

  test('fingerprinted requests are immutable for a year; others use the fallback', () => {
    const headers = {};
    const res = (query) => ({ req: { query }, setHeader: (k, v) => (headers[k] = v) });
    const set = cacheHeaders('public, max-age=604800');
    set(res({ v: 'abc' }));
    expect(headers['Cache-Control']).toBe(ONE_YEAR);
    set(res({}));
    expect(headers['Cache-Control']).toBe('public, max-age=604800');
  });
});

describe('image width/height', () => {
  test('crop size wins; otherwise the image’s own shape scales the width', () => {
    expect(imgSize({ publicId: 'a' }, { w: 400, h: 300 })).toBe('width="400" height="300"');
    expect(imgSize({ publicId: 'a', width: 1600, height: 1200 }, { w: 800 })).toBe(
      'width="800" height="600"',
    );
    expect(imgSize({ publicId: 'a', width: 1600, height: 1200 })).toBe(
      'width="1600" height="1200"',
    );
  });

  test('bundled placeholders are measured from the WebP header', () => {
    expect(imgSize({ legacy: '/images/site/hero' }, { w: 2200 })).toBe(
      'width="2200" height="1457"',
    );
  });

  test('unknown size → no attributes rather than wrong ones', () => {
    expect(imgSize({ publicId: 'a' })).toBe('');
    expect(imgSize({ legacy: '/uploads/gone/x' })).toBe('');
    expect(imgSize(null)).toBe('');
  });

  test('webpSize reads lossy, lossless and extended headers', () => {
    const riff = (kind, body) =>
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
        Buffer.from(kind),
        body,
      ]);
    const vp8 = Buffer.alloc(18);
    vp8.writeUInt16LE(640, 10);
    vp8.writeUInt16LE(480, 12);
    expect(webpSize(riff('VP8 ', vp8))).toEqual({ width: 640, height: 480 });

    const vp8l = Buffer.alloc(18);
    vp8l.writeUInt32LE((640 - 1) | ((480 - 1) << 14), 5);
    expect(webpSize(riff('VP8L', vp8l))).toEqual({ width: 640, height: 480 });

    const vp8x = Buffer.alloc(18);
    vp8x.writeUIntLE(640 - 1, 8, 3);
    vp8x.writeUIntLE(480 - 1, 11, 3);
    expect(webpSize(riff('VP8X', vp8x))).toEqual({ width: 640, height: 480 });

    expect(webpSize(Buffer.from('not a webp at all, definitely not'))).toBeNull();
  });
});
