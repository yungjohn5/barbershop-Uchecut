// One-off move of bundled/legacy photos to (mocked) Cloudinary: what gets uploaded, what
// gets stored, idempotent re-runs, missing files and the dry run.
process.env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';
process.env.CLOUDINARY_FOLDER = 'victory/test';
jest.mock('cloudinary', () => require('../helpers/cloudinaryMock'));
const cloud = require('../helpers/cloudinaryMock');
const { prisma, resetDb, seedFixtures } = require('./fixtures');
const settings = require('../../src/services/settings');
const { SITE_SLOTS } = require('../../src/lib/images');
const { uploadLocalImages } = require('../../scripts/upload-local-images');

const SLOTS = Object.keys(SITE_SLOTS).length;
const quiet = () => {};
let fx;

beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
  cloud.reset();
  settings.invalidate();
  await prisma.service.update({
    where: { id: fx.cut.id },
    data: { legacyImagePath: '/images/site/svc-skin-fade' }, // bundled file exists
  });
  await prisma.barber.update({
    where: { id: fx.homeBarber.id },
    data: { legacyPhotoPath: '/uploads/barbers/gone-123' }, // file no longer on disk
  });
});
afterAll(() => prisma.$disconnect());

test('uploads legacy records and empty site slots, storing only publicId/version/size', async () => {
  const report = await uploadLocalImages({ db: prisma, log: quiet });
  expect(report).toEqual({ uploaded: 1 + SLOTS, skipped: 0, missing: 1 });

  const svc = await prisma.service.findUnique({ where: { id: fx.cut.id } });
  expect(svc).toMatchObject({
    imagePublicId: expect.stringMatching(/^victory\/test\/services\//),
    imageVersion: expect.any(Number),
    imageWidth: 1000,
    imageHeight: 800,
    legacyImagePath: null,
  });
  // uploaded into the services folder
  const first = cloud.state.uploads.find((u) => u.opts.folder === 'victory/test/services');
  expect(first).toBeDefined();

  const row = await prisma.setting.findUnique({ where: { key: 'siteImages' } });
  expect(Object.keys(row.value).sort()).toEqual(Object.keys(SITE_SLOTS).sort());
  expect(row.value.hero.publicId).toMatch(/^victory\/test\/site\/hero/);

  // the missing file is reported and its row left alone
  const barber = await prisma.barber.findUnique({ where: { id: fx.homeBarber.id } });
  expect(barber).toMatchObject({
    photoPublicId: null,
    legacyPhotoPath: '/uploads/barbers/gone-123',
  });
});

test('re-running skips everything already on Cloudinary', async () => {
  await uploadLocalImages({ db: prisma, log: quiet });
  cloud.reset();
  const again = await uploadLocalImages({ db: prisma, log: quiet });
  expect(again).toEqual({ uploaded: 0, skipped: SLOTS, missing: 1 });
  expect(cloud.v2.uploader.upload_stream).not.toHaveBeenCalled();
});

test('dry run reports what would move and changes nothing', async () => {
  const lines = [];
  const report = await uploadLocalImages({ db: prisma, dryRun: true, log: (l) => lines.push(l) });
  expect(report.uploaded).toBe(1 + SLOTS);
  expect(cloud.v2.uploader.upload_stream).not.toHaveBeenCalled();
  expect(lines.some((l) => /would upload .*svc-skin-fade/.test(l))).toBe(true);
  const svc = await prisma.service.findUnique({ where: { id: fx.cut.id } });
  expect(svc.legacyImagePath).toBe('/images/site/svc-skin-fade');
  expect(await prisma.setting.findUnique({ where: { key: 'siteImages' } })).toBeNull();
});
