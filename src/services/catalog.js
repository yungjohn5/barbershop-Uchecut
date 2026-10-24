// Owner-managed catalogue: categories, services, zones, products and gallery.
// Form input arrives as strings; schemas here coerce and validate it. Money is typed in
// naira and stored in kobo.
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ValidationError, HttpError, NotFoundError } = require('../lib/errors');
const images = require('./images');

// ---------------------------------------------------------------------------
// Parsing helpers (pure)
// ---------------------------------------------------------------------------

/** "7,500" → 750000, "7500.5" → 750050. Returns null for blank input, NaN for junk. */
function nairaToKobo(input) {
  const s = String(input ?? '')
    .replace(/[₦,\s]/g, '')
    .trim();
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** kobo → plain naira string for an input value: 750000 → "7500", 750050 → "7500.50". */
function koboToInput(kobo) {
  if (kobo === null || kobo === undefined) return '';
  return kobo % 100 ? (kobo / 100).toFixed(2) : String(kobo / 100);
}

function slugify(s) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

/** First free slug: "skin-fade", then "skin-fade-2", … */
async function uniqueSlug(delegate, name, excludeId = null) {
  const base = slugify(name);
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const hit = await delegate.findUnique({ where: { slug } });
    if (!hit || hit.id === excludeId) return slug;
  }
  throw new Error('Could not find a free slug');
}

const checkbox = z.preprocess(
  (v) => v === 'on' || v === 'true' || v === '1' || v === true,
  z.boolean(),
);
const optionalText = (max) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    z.string().max(max).nullable(),
  );
const name = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z
    .string({ error: 'Enter a name.' })
    .min(2, 'Enter a name.')
    .max(60, 'Keep it under 60 characters.'),
);
const kobo = (label, { optional = false } = {}) =>
  z
    .preprocess(
      (v) => nairaToKobo(v),
      optional
        ? z
            .number({ error: `Enter the ${label.toLowerCase()} in naira, e.g. 7500.` })
            .int()
            .min(0, `${label} can’t be negative.`)
            .max(100_000_000)
            .nullable()
        : z
            .number({ error: `Enter the ${label.toLowerCase()} in naira, e.g. 7500.` })
            .int()
            .min(0, `${label} can’t be negative.`)
            .max(100_000_000, `${label} looks too high.`),
    )
    .refine(
      (v) => v === null || !Number.isNaN(v),
      `Enter the ${label.toLowerCase()} in naira, e.g. 7500.`,
    );
const intIn = (min, max, msg) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? Number.NaN : Number(v)),
    z.number({ error: msg }).int(msg).min(min, msg).max(max, msg),
  );
const idList = z.preprocess(
  (v) =>
    []
      .concat(v ?? [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  z.array(z.number().int().positive()),
);

const schemas = {
  category: z.object({ name }),
  service: z.object({
    name,
    description: optionalText(400),
    price: kobo('Price'),
    durationMin: intIn(5, 480, 'Duration must be between 5 and 480 minutes.').refine(
      (n) => n % 5 === 0,
      'Use steps of 5 minutes.',
    ),
    categoryId: intIn(1, 1e9, 'Choose a category.'),
    homeAvailable: checkbox,
    active: checkbox,
    barberIds: idList,
  }),
  zone: z.object({
    name,
    fee: kobo('Fee'),
    travelBufferMin: intIn(0, 180, 'Travel time must be 0–180 minutes.'),
    active: checkbox,
  }),
  product: z.object({
    name,
    description: optionalText(400),
    price: kobo('Price', { optional: true }),
    visible: checkbox,
  }),
  gallery: z.object({
    caption: optionalText(120),
    barberId: z.preprocess((v) => (v ? Number(v) : null), z.number().int().positive().nullable()),
    visible: checkbox,
  }),
};

/** Validate form input; throws ValidationError with { path, message } details. */
function parse(schema, body) {
  const r = schema.safeParse(body || {});
  if (r.success) return r.data;
  throw new ValidationError(
    'Please check the highlighted fields.',
    r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Move a row up or down within its group (rewrites sortOrder as 10, 20, 30…). */
async function move(model, id, dir, { where = {}, db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    const rows = await tx[model].findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) throw new NotFoundError();
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return false;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    await Promise.all(
      rows.map((r, k) =>
        tx[model].update({ where: { id: r.id }, data: { sortOrder: (k + 1) * 10 } }),
      ),
    );
    return true;
  });
}

const nextSortOrder = async (delegate, where = {}) => {
  const last = await delegate.findFirst({
    where,
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last ? last.sortOrder : 0) + 10;
};

// Swap in a new image (if uploaded) and remove the old files afterwards.
async function withImage(file, { kind, name, current }) {
  if (!file) return { url: current, cleanup: async () => {} };
  const url = await images.saveUpload(file.buffer, { kind, name });
  return { url, cleanup: () => images.removeUpload(current, { kind }) };
}

// ---------------------------------------------------------------------------
// Categories and services
// ---------------------------------------------------------------------------

async function listCatalogue({ db = prisma } = {}) {
  return db.serviceCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      services: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { bookings: true, barbers: true } } },
      },
    },
  });
}

async function saveCategory(id, body, { db = prisma } = {}) {
  const data = parse(schemas.category, body);
  const clash = await db.serviceCategory.findFirst({
    where: { name: { equals: data.name, mode: 'insensitive' }, NOT: id ? { id } : undefined },
  });
  if (clash)
    throw new ValidationError('A category with that name already exists.', [
      { path: 'name', message: 'Already exists.' },
    ]);
  const slug = await uniqueSlug(db.serviceCategory, data.name, id);
  if (id) return db.serviceCategory.update({ where: { id }, data: { name: data.name, slug } });
  return db.serviceCategory.create({
    data: { name: data.name, slug, sortOrder: await nextSortOrder(db.serviceCategory) },
  });
}

async function deleteCategory(id, { db = prisma } = {}) {
  const count = await db.service.count({ where: { categoryId: id } });
  if (count) throw new HttpError(409, 'Move or delete the services in this category first.');
  await db.serviceCategory.delete({ where: { id } });
}

async function getService(id, { db = prisma } = {}) {
  return db.service.findUnique({
    where: { id },
    include: { barbers: true, _count: { select: { bookings: true } } },
  });
}

async function saveService(id, body, { file, db = prisma } = {}) {
  const data = parse(schemas.service, body);
  const current = id ? await db.service.findUnique({ where: { id } }) : null;
  if (id && !current) throw new NotFoundError('Service not found');
  if (!(await db.serviceCategory.findUnique({ where: { id: data.categoryId } }))) {
    throw new ValidationError('Choose a category.', [
      { path: 'categoryId', message: 'Choose a category.' },
    ]);
  }
  const image = await withImage(file, {
    kind: 'services',
    name: data.name,
    current: current && current.imageUrl,
  });
  const fields = {
    name: data.name,
    slug: await uniqueSlug(db.service, data.name, id),
    description: data.description,
    priceKobo: data.price,
    durationMin: data.durationMin,
    categoryId: data.categoryId,
    homeAvailable: data.homeAvailable,
    active: data.active,
    imageUrl: image.url,
  };
  const saved = await db.$transaction(async (tx) => {
    const row = id
      ? await tx.service.update({ where: { id }, data: fields })
      : await tx.service.create({
          data: {
            ...fields,
            sortOrder: await nextSortOrder(tx.service, { categoryId: data.categoryId }),
          },
        });
    await tx.barberService.deleteMany({ where: { serviceId: row.id } });
    if (data.barberIds.length) {
      await tx.barberService.createMany({
        data: data.barberIds.map((barberId) => ({ barberId, serviceId: row.id })),
        skipDuplicates: true,
      });
    }
    return row;
  });
  await image.cleanup();
  return saved;
}

/** Services with bookings are kept for history: hide them instead. */
async function deleteService(id, { db = prisma } = {}) {
  const s = await db.service.findUnique({
    where: { id },
    include: { _count: { select: { bookings: true } } },
  });
  if (!s) throw new NotFoundError('Service not found');
  if (s._count.bookings)
    throw new HttpError(409, 'This service has bookings, so it can’t be deleted. Hide it instead.');
  await db.service.delete({ where: { id } });
  await images.removeUpload(s.imageUrl, { kind: 'services' });
}

const setActive = (id, active, { db = prisma } = {}) =>
  db.service.update({ where: { id }, data: { active } });

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const listZones = ({ db = prisma } = {}) =>
  db.zone.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { bookings: true } } },
  });

async function saveZone(id, body, { db = prisma } = {}) {
  const data = parse(schemas.zone, body);
  const clash = await db.zone.findFirst({
    where: { name: { equals: data.name, mode: 'insensitive' }, NOT: id ? { id } : undefined },
  });
  if (clash)
    throw new ValidationError('A zone with that name already exists.', [
      { path: 'name', message: 'Already exists.' },
    ]);
  const fields = {
    name: data.name,
    feeKobo: data.fee,
    travelBufferMin: data.travelBufferMin,
    active: data.active,
  };
  if (id) return db.zone.update({ where: { id }, data: fields });
  return db.zone.create({ data: { ...fields, sortOrder: await nextSortOrder(db.zone) } });
}

async function deleteZone(id, { db = prisma } = {}) {
  const count = await db.booking.count({ where: { zoneId: id } });
  if (count)
    throw new HttpError(
      409,
      'This zone has bookings, so it can’t be deleted. Switch it off instead.',
    );
  await db.zone.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const listProducts = ({ db = prisma } = {}) =>
  db.product.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });

async function saveProduct(id, body, { file, db = prisma } = {}) {
  const data = parse(schemas.product, body);
  const current = id ? await db.product.findUnique({ where: { id } }) : null;
  if (id && !current) throw new NotFoundError('Product not found');
  const image = await withImage(file, {
    kind: 'products',
    name: data.name,
    current: current && current.imageUrl,
  });
  const fields = {
    name: data.name,
    slug: await uniqueSlug(db.product, data.name, id),
    description: data.description,
    priceKobo: data.price,
    visible: data.visible,
    imageUrl: image.url,
  };
  const saved = id
    ? await db.product.update({ where: { id }, data: fields })
    : await db.product.create({ data: { ...fields, sortOrder: await nextSortOrder(db.product) } });
  await image.cleanup();
  return saved;
}

async function deleteProduct(id, { db = prisma } = {}) {
  const p = await db.product.delete({ where: { id } });
  await images.removeUpload(p.imageUrl, { kind: 'products' });
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

const listGallery = ({ db = prisma } = {}) =>
  db.galleryItem.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { barber: true },
  });

async function addGalleryItem(body, { file, db = prisma } = {}) {
  const data = parse(schemas.gallery, body);
  if (!file)
    throw new ValidationError('Choose a photo to upload.', [
      { path: 'image', message: 'Choose a photo.' },
    ]);
  const url = await images.saveUpload(file.buffer, {
    kind: 'gallery',
    name: data.caption || 'cut',
  });
  return db.galleryItem.create({
    data: { ...data, imageUrl: url, sortOrder: await nextSortOrder(db.galleryItem) },
  });
}

async function updateGalleryItem(id, body, { db = prisma } = {}) {
  const data = parse(schemas.gallery, body);
  return db.galleryItem.update({ where: { id }, data });
}

async function deleteGalleryItem(id, { db = prisma } = {}) {
  const g = await db.galleryItem.delete({ where: { id } });
  await images.removeUpload(g.imageUrl, { kind: 'gallery' });
}

module.exports = {
  nairaToKobo,
  koboToInput,
  slugify,
  uniqueSlug,
  parse,
  schemas,
  move,
  listCatalogue,
  saveCategory,
  deleteCategory,
  getService,
  saveService,
  deleteService,
  setActive,
  listZones,
  saveZone,
  deleteZone,
  listProducts,
  saveProduct,
  deleteProduct,
  listGallery,
  addGalleryItem,
  updateGalleryItem,
  deleteGalleryItem,
};
