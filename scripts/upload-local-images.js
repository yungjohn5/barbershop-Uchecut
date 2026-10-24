// One-off: move images that still point at local files (legacy*Path columns and empty site
// photo slots) to Cloudinary, then store { publicId, version, width, height } and clear the
// legacy path. Idempotent: re-running skips anything already on Cloudinary.
//   npm run images:upload             (needs CLOUDINARY_URL)
//   npm run images:upload -- --dry-run
require('dotenv').config({ quiet: true });
const fs = require('fs/promises');
const path = require('path');
const prisma = require('../src/lib/prisma');
const env = require('../src/config/env');
const images = require('../src/services/images');
const { legacyWidths, SITE_SLOTS } = require('../src/lib/images');
const settings = require('../src/services/settings');

const PUBLIC = path.join(__dirname, '..', 'public');

/** The largest local file for a legacy base path, e.g. /images/site/hero → hero-2200.webp. */
async function readLargest(base) {
  const widths = [...legacyWidths(base)].sort((a, b) => b - a);
  for (const w of widths) {
    const file = path.join(PUBLIC, `${base}-${w}.webp`);
    try {
      return { buffer: await fs.readFile(file), file };
    } catch {
      // try the next size
    }
  }
  return null;
}

const MODELS = [
  { model: 'service', field: 'image', kind: 'services', name: (r) => r.slug },
  { model: 'product', field: 'image', kind: 'products', name: (r) => r.slug },
  {
    model: 'galleryItem',
    field: 'image',
    kind: 'gallery',
    name: (r) => r.caption || `gallery-${r.id}`,
  },
  { model: 'barber', field: 'photo', kind: 'barbers', name: (r) => r.slug },
];

async function uploadLocalImages({ db = prisma, dryRun = false, log = console.log } = {}) {
  if (!env.CLOUDINARY_URL && !dryRun) {
    throw new Error(
      'CLOUDINARY_URL is not set. Add it to .env (cloudinary://<key>:<secret>@<cloud>) and re-run.',
    );
  }
  const report = { uploaded: 0, missing: 0, skipped: 0 };

  for (const m of MODELS) {
    const legacyCol = `legacy${m.field[0].toUpperCase()}${m.field.slice(1)}Path`;
    const rows = await db[m.model].findMany({ where: { [legacyCol]: { not: null } } });
    for (const row of rows) {
      if (row[`${m.field}PublicId`]) {
        report.skipped++;
        continue;
      }
      const local = await readLargest(row[legacyCol]);
      if (!local) {
        log(`  missing file for ${m.model} #${row.id} (${row[legacyCol]})`);
        report.missing++;
        continue;
      }
      if (dryRun) {
        log(
          `  would upload ${path.relative(PUBLIC, local.file)} → ${env.CLOUDINARY_FOLDER}/${m.kind}`,
        );
        report.uploaded++;
        continue;
      }
      const up = await images.uploadImage(local.buffer, { kind: m.kind, name: m.name(row) });
      await db[m.model].update({ where: { id: row.id }, data: images.fieldsFor(m.field, up) });
      log(`  ${m.model} #${row.id} → ${up.publicId}`);
      report.uploaded++;
    }
  }

  const row = await db.setting.findUnique({ where: { key: 'siteImages' } });
  const siteImages = (row && row.value) || {};
  let changed = false;
  for (const [slot, def] of Object.entries(SITE_SLOTS)) {
    if (siteImages[slot] && siteImages[slot].publicId) {
      report.skipped++;
      continue;
    }
    const local = await readLargest(def.legacy);
    if (!local) {
      report.missing++;
      continue;
    }
    if (dryRun) {
      log(
        `  would upload ${path.relative(PUBLIC, local.file)} → ${env.CLOUDINARY_FOLDER}/site (${slot})`,
      );
      report.uploaded++;
      continue;
    }
    siteImages[slot] = await images.uploadImage(local.buffer, { kind: 'site', name: slot });
    log(`  site photo ${slot} → ${siteImages[slot].publicId}`);
    report.uploaded++;
    changed = true;
  }
  if (changed) {
    await db.setting.upsert({
      where: { key: 'siteImages' },
      update: { value: siteImages },
      create: { key: 'siteImages', value: siteImages },
    });
    settings.invalidate();
  }
  return report;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    `${dryRun ? '[dry run] ' : ''}Uploading local images to Cloudinary folder ${env.CLOUDINARY_FOLDER}…`,
  );
  uploadLocalImages({ dryRun })
    .then((r) => {
      console.log(
        `Done: ${r.uploaded} uploaded, ${r.skipped} already on Cloudinary, ${r.missing} missing files.`,
      );
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { uploadLocalImages };
