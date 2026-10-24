// Cloudinary images: URL/srcset helpers, site photo slots, and the upload service against a
// mocked SDK (validation, what gets saved, deleting old images without blocking).
process.env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
process.env.CLOUDINARY_FOLDER = 'victory/test';
jest.mock('cloudinary', () => require('../helpers/cloudinaryMock'));
const cloud = require('../helpers/cloudinaryMock');
const { imageOf, imageUrl, srcset, siteImage, transform } = require('../../src/lib/images');
const images = require('../../src/services/images');

beforeEach(() => cloud.reset());

const asset = {
  publicId: 'victory/test/services/skin-fade-abc',
  version: 1712345678,
  width: 1600,
  height: 1200,
};

describe('URL helpers', () => {
  test('transformations always include f_auto,q_auto', () => {
    expect(transform()).toBe('f_auto,q_auto');
    expect(transform({ w: 800 })).toBe('f_auto,q_auto,c_fill,w_800');
    expect(transform({ w: 400, h: 400 })).toBe('f_auto,q_auto,c_fill,g_auto,w_400,h_400');
    expect(transform({ w: 1200, h: 630, crop: 'fill', gravity: 'face' })).toContain('g_face');
  });

  test('imageUrl uses the cloud name from CLOUDINARY_URL and the version', () => {
    expect(imageUrl(asset, { w: 800 })).toBe(
      'https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto,c_fill,w_800/v1712345678/victory/test/services/skin-fade-abc',
    );
    expect(imageUrl(null)).toBe('');
  });

  test('srcset lists each width, optionally cropped to a ratio', () => {
    const set = srcset(asset, [400, 800, 1200]);
    expect(set.split(', ')).toHaveLength(3);
    expect(set).toMatch(/w_400\/v1712345678\/victory\/test\/services\/skin-fade-abc 400w/);
    expect(srcset(asset, [400], { ratio: 0.75 })).toContain('w_400,h_300');
  });

  test('legacy local images keep working until they are uploaded', () => {
    const legacy = { legacy: '/images/site/hero' };
    expect(imageUrl(legacy, { w: 1000 })).toBe('/images/site/hero-1400.webp');
    expect(srcset(legacy)).toBe(
      '/images/site/hero-800.webp 800w, /images/site/hero-1400.webp 1400w, /images/site/hero-2200.webp 2200w',
    );
  });

  test('imageOf builds a descriptor from a record', () => {
    expect(
      imageOf({
        imagePublicId: 'a/b',
        imageVersion: 3,
        imageWidth: 10,
        imageHeight: 20,
        legacyImagePath: '/x',
      }),
    ).toEqual({ publicId: 'a/b', version: 3, width: 10, height: 20 });
    expect(imageOf({ legacyPhotoPath: '/images/site/barber-tunde' }, 'photo')).toEqual({
      legacy: '/images/site/barber-tunde',
    });
    expect(imageOf({})).toBeNull();
  });

  test('site slots fall back to the bundled placeholder', () => {
    expect(siteImage('hero', {})).toEqual({ legacy: '/images/site/hero' });
    expect(siteImage('hero', { hero: asset })).toBe(asset);
    expect(() => siteImage('nope', {})).toThrow(/Unknown site image slot/);
  });
});

describe('upload service', () => {
  test('uploads into {folder}/{kind} and returns only publicId, version and size', async () => {
    const out = await images.uploadImage(cloud.png(), { kind: 'gallery', name: 'Low Taper!' });
    expect(out).toEqual({
      publicId: expect.stringMatching(/^victory\/test\/gallery\/low-taper-/),
      version: expect.any(Number),
      width: 1000,
      height: 800,
    });
    expect(cloud.state.uploads[0].opts).toMatchObject({
      folder: 'victory/test/gallery',
      resource_type: 'image',
      overwrite: false,
    });
  });

  test.each([
    ['empty', Buffer.alloc(0), /Choose a photo/],
    ['not an image', Buffer.from('MZ executable'), /isn’t an image/],
    ['SVG', Buffer.from('<svg/>'), /isn’t an image/],
    ['over 8 MB', Buffer.concat([cloud.jpeg(), Buffer.alloc(8 * 1024 * 1024)]), /8 MB/],
  ])('refuses %s before calling Cloudinary', async (_label, buf, message) => {
    await expect(images.uploadImage(buf, { kind: 'services', name: 'x' })).rejects.toThrow(message);
    expect(cloud.v2.uploader.upload_stream).not.toHaveBeenCalled();
  });

  test('a too-small result is deleted again', async () => {
    cloud.state.width = 320;
    await expect(images.uploadImage(cloud.jpeg(), { kind: 'products', name: 'x' })).rejects.toThrow(
      /too small/,
    );
    await images.settled();
    expect(cloud.state.destroyed).toEqual([cloud.state.uploads[0].result.public_id]);
  });

  test('destroy failures are swallowed and logged', async () => {
    cloud.state.destroyFail = true;
    await expect(images.destroyImage('victory/test/x')).resolves.toBe(false);
    images.destroyLater('victory/test/y');
    await expect(images.settled()).resolves.toBeDefined();
  });

  test('fieldsFor clears the legacy path', () => {
    expect(images.fieldsFor('photo', asset)).toEqual({
      photoPublicId: asset.publicId,
      photoVersion: asset.version,
      photoWidth: 1600,
      photoHeight: 1200,
      legacyPhotoPath: null,
    });
  });
});
