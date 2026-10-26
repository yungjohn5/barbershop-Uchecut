// DEMO data only: placeholder services, barbers, hours, zones, products, fake customers
// (0803 000 00xx) and ~6 weeks of bookings (scripts/demo-bookings.js) so the site and admin
// have something to show. Never for production (refuses to run there); real content is
// entered in the admin (see docs/LAUNCH-CONTENT.md). Only runs on an empty catalogue.
// Run after the base seed:  npm run db:seed && npm run db:seed:demo
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

if (process.env.NODE_ENV === 'production') {
  console.error(
    'seed-demo refuses to run with NODE_ENV=production (it creates fake services, barbers and zones).',
  );
  process.exit(1);
}

const { DEFAULT_SETTINGS } = require('../src/config/constants');
const { seedDemoBookings } = require('./demo-bookings');

const prisma = new PrismaClient();
const naira = (n) => n * 100; // → kobo

const categories = [
  { name: 'Cut & Craft', slug: 'cut-craft', sortOrder: 1 },
  { name: 'Beard & Grooming', slug: 'beard-grooming', sortOrder: 2 },
  { name: 'Signature Rituals', slug: 'signature-rituals', sortOrder: 3 },
  { name: 'Maintenance & Care', slug: 'maintenance-care', sortOrder: 4 },
];

const services = [
  {
    slug: 'classic-haircut',
    name: 'Classic Haircut',
    category: 'cut-craft',
    price: 7500,
    duration: 45,
    home: true,
    description: 'Consultation, precision cut and a clean finish.',
  },
  {
    slug: 'skin-fade',
    name: 'Skin Fade',
    category: 'cut-craft',
    price: 9000,
    duration: 45,
    home: true,
    description: 'Seamless fade down to the skin, sharp line-up.',
  },
  {
    slug: 'scissor-cut',
    name: 'Scissor Cut',
    category: 'cut-craft',
    price: 10000,
    duration: 60,
    home: true,
    description: 'Fully scissor-cut for longer textures and curls.',
  },
  {
    slug: 'beard-trim',
    name: 'Beard Trim & Line-up',
    category: 'beard-grooming',
    price: 4000,
    duration: 20,
    home: true,
    description: 'Shape, trim and razor line-up.',
  },
  {
    slug: 'hot-towel-shave',
    name: 'Hot Towel Shave',
    category: 'beard-grooming',
    price: 6000,
    duration: 30,
    home: false,
    description: 'Traditional straight-razor shave with hot towels. In shop only.',
  },
  {
    slug: 'victory-ritual',
    name: 'The Victory Ritual',
    category: 'signature-rituals',
    price: 18000,
    duration: 90,
    home: false,
    description: 'Cut, beard, hot towel and scalp treatment. In shop only.',
  },
  {
    slug: 'shape-up',
    name: 'Shape-up',
    category: 'maintenance-care',
    price: 3000,
    duration: 15,
    home: true,
    description: 'Quick edge-up between cuts.',
  },
  {
    slug: 'kids-cut',
    name: 'Kids Cut (under 12)',
    category: 'maintenance-care',
    price: 5000,
    duration: 30,
    home: true,
    description: 'A calm, patient cut for younger clients.',
  },
];

const barbers = [
  {
    slug: 'tunde',
    name: 'Tunde A.',
    doesHomeService: true,
    sortOrder: 1,
    legacyPhotoPath: '/images/site/barber-tunde',
    bio: 'Precise fades and razor-sharp line-ups. Calm, quick, and the barber who brings the chair to you on home visits.',
    specialties: ['Skin fades', 'Line-ups', 'Home visits'],
  },
  {
    slug: 'emeka',
    name: 'Emeka O.',
    doesHomeService: false,
    sortOrder: 2,
    legacyPhotoPath: '/images/site/barber-emeka',
    bio: 'Two decades behind the chair. Patient scissor work, classic hot-towel shaves, and the steadiest hand for kids’ first cuts.',
    specialties: ['Scissor cuts', 'Hot towel shaves', 'Kids'],
  },
];

// Display-only products (no cart). Images: public/images/site/prod-*-{400,800}.webp
const products = [
  {
    slug: 'matte-clay',
    name: 'Matte Clay',
    price: 9500,
    image: 'prod-clay',
    description: 'Strong hold, zero shine. Built for short, textured cuts.',
  },
  {
    slug: 'beard-oil',
    name: 'Beard Oil',
    price: 8000,
    image: 'prod-beard-oil',
    description: 'Light oil that softens and tames without the grease.',
  },
  {
    slug: 'scalp-tonic',
    name: 'Scalp Tonic',
    price: 7000,
    image: 'prod-tonic',
    description: 'A cooling tonic for a clean, healthy scalp after a fresh cut.',
  },
  {
    slug: 'grooming-set',
    name: 'The Grooming Set',
    price: 22000,
    image: 'prod-kit',
    description: 'Clay, oil and tonic together: the full routine.',
  },
  {
    slug: 'straight-razor',
    name: 'Straight Razor',
    price: 15000,
    image: 'prod-razor',
    description: 'The razor we finish every line-up with.',
  },
];

// weekday 0 = Sunday. Mon–Fri 10:00–20:00, Sat 10:00–18:00, Sun closed.
const weeklyHours = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 600, endMin: 1200 })),
  { weekday: 6, startMin: 600, endMin: 1080 },
];

// Lookbook (Gallery). Images: public/images/site/look-NN-{600,1200}.webp; barber = slug or null.
const gallery = [
  ['Tools of the trade', null],
  ['Clean neckline', 'tunde'],
  ['Ready for the next chair', 'tunde'],
  ['Taper, worked slowly', 'tunde'],
  ['Clipper detail', null],
  ['The mirror moment', 'emeka'],
  ['Low fade in progress', 'tunde'],
  ['Crown work', 'tunde'],
  ['Line-up', 'tunde'],
  ['First proper cut', 'emeka'],
  ['Trimmer set to zero', 'tunde'],
  ['Shape check', 'emeka'],
];

const zones = [
  { name: 'Lekki', fee: 5000, buffer: 45, sortOrder: 1 },
  { name: 'Victoria Island', fee: 4000, buffer: 40, sortOrder: 2 },
  { name: 'Ikeja', fee: 7000, buffer: 60, sortOrder: 3 },
  { name: 'Yaba', fee: 4500, buffer: 45, sortOrder: 4 },
];

async function main() {
  // Demo data only goes into an EMPTY catalogue. Matching existing rows by slug is unsafe:
  // the admin regenerates slugs when names change, and demo values would overwrite real edits.
  const [serviceCount, barberCount] = await Promise.all([
    prisma.service.count(),
    prisma.barber.count(),
  ]);
  if (serviceCount || barberCount) {
    console.error(
      `seed-demo: the database already has ${serviceCount} service(s) and ${barberCount} barber(s); not touching it. ` +
        'Use an empty database (e.g. after `npm run db:reset`).',
    );
    process.exitCode = 1;
    return;
  }

  const catIds = {};
  for (const c of categories) {
    const row = await prisma.serviceCategory.upsert({
      where: { slug: c.slug },
      update: { name: c.name, sortOrder: c.sortOrder },
      create: c,
    });
    catIds[c.slug] = row.id;
  }

  const serviceIds = [];
  for (const [i, s] of services.entries()) {
    const data = {
      name: s.name,
      description: s.description,
      priceKobo: naira(s.price),
      durationMin: s.duration,
      homeAvailable: s.home,
      legacyImagePath: `/images/site/svc-${s.slug}`,
      sortOrder: i + 1,
      categoryId: catIds[s.category],
    };
    const row = await prisma.service.upsert({
      where: { slug: s.slug },
      update: data,
      create: { slug: s.slug, ...data },
    });
    serviceIds.push(row.id);
  }

  for (const b of barbers) {
    const { slug, ...data } = b;
    const barber = await prisma.barber.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });
    await prisma.barberService.createMany({
      data: serviceIds.map((serviceId) => ({ barberId: barber.id, serviceId })),
      skipDuplicates: true,
    });
    for (const h of weeklyHours) {
      await prisma.workingHours.upsert({
        where: {
          barberId_weekday_startMin: {
            barberId: barber.id,
            weekday: h.weekday,
            startMin: h.startMin,
          },
        },
        update: { endMin: h.endMin },
        create: { barberId: barber.id, ...h },
      });
    }
  }

  for (const z of zones) {
    const data = { feeKobo: naira(z.fee), travelBufferMin: z.buffer, sortOrder: z.sortOrder };
    await prisma.zone.upsert({
      where: { name: z.name },
      update: data,
      create: { name: z.name, ...data },
    });
  }

  for (const [i, p] of products.entries()) {
    const data = {
      name: p.name,
      description: p.description,
      priceKobo: naira(p.price),
      legacyImagePath: `/images/site/${p.image}`,
      sortOrder: i + 1,
    };
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: data,
      create: { slug: p.slug, ...data },
    });
  }

  const barberIdBySlug = Object.fromEntries(
    (await prisma.barber.findMany({ select: { id: true, slug: true } })).map((b) => [b.slug, b.id]),
  );
  if (!(await prisma.galleryItem.count())) {
    await prisma.galleryItem.createMany({
      data: gallery.map(([caption, barber], i) => ({
        caption,
        legacyImagePath: `/images/site/look-${String(i + 1).padStart(2, '0')}`,
        barberId: barber ? barberIdBySlug[barber] : null,
        sortOrder: i + 1,
      })),
    });
  }

  // Demo shop contacts: obviously fake, so screenshots and recordings never show a real number
  // or the "Placeholder address". The base seed may already have written the shop row with
  // the defaults, so fill in only the fields still at their placeholder value.
  const demoContacts = {
    address: ['Admiralty Way, Lekki Phase 1', 'Lagos, Nigeria'],
    phone: '+2348030000000',
    whatsapp: '2348030000000',
    email: 'hello@victory.example',
  };
  const shopRow = await prisma.setting.findUnique({ where: { key: 'shop' } });
  const current = { ...DEFAULT_SETTINGS.shop, ...((shopRow && shopRow.value) || {}) };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const filled = { ...current };
  for (const [k, v] of Object.entries(demoContacts)) {
    if (same(current[k], DEFAULT_SETTINGS.shop[k])) filled[k] = v;
  }
  await prisma.setting.upsert({
    where: { key: 'shop' },
    update: { value: filled },
    create: { key: 'shop', value: filled },
  });

  const [svcRows, barberRows, zoneRows] = await Promise.all([
    prisma.service.findMany({ where: { active: true } }),
    prisma.barber.findMany({ include: { hours: true } }),
    prisma.zone.findMany({ where: { active: true } }),
  ]);
  const history = await seedDemoBookings(prisma, {
    services: svcRows,
    barbers: barberRows,
    zones: zoneRows,
  });

  console.log(
    `Demo data: ${categories.length} categories, ${services.length} services, ` +
      `${barbers.length} barbers, ${zones.length} zones, ${products.length} products, ${gallery.length} lookbook photos, ` +
      `${history.customers} customers (0803 000 00xx), ${history.bookings} bookings.`,
  );

  // Demo photos point at the bundled files; move them to Cloudinary when it's configured.
  if (process.env.CLOUDINARY_URL) {
    const { uploadLocalImages } = require('./upload-local-images');
    const r = await uploadLocalImages({ db: prisma });
    console.log(`Demo photos on Cloudinary: ${r.uploaded} uploaded.`);
  } else {
    console.log(
      'CLOUDINARY_URL not set: demo photos use the bundled files until `npm run images:upload`.',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
