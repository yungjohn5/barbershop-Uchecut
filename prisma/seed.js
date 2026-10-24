// Production-safe base seed (`npm run db:seed`): service categories, default settings and the
// first OWNER admin from the environment. Never creates demo content (that's
// scripts/seed-demo.js) and never overwrites anything the owner has edited. Idempotent.
require('dotenv').config({ quiet: true });
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { DEFAULT_SETTINGS } = require('../src/config/constants');

const prisma = new PrismaClient();
const isProd = process.env.NODE_ENV === 'production';

const categories = [
  { name: 'Cut & Craft', slug: 'cut-craft', sortOrder: 1 },
  { name: 'Beard & Grooming', slug: 'beard-grooming', sortOrder: 2 },
  { name: 'Signature Rituals', slug: 'signature-rituals', sortOrder: 3 },
  { name: 'Maintenance & Care', slug: 'maintenance-care', sortOrder: 4 },
];

// Same list the app refuses at boot in production (src/config/env.js).
const EXAMPLE_ADMIN_PASSWORDS = ['change-me-please', 'barbershop2026', 'password123456'];

async function main() {
  for (const c of categories) {
    // create only: the owner may have renamed or reordered them
    await prisma.serviceCategory.upsert({ where: { slug: c.slug }, update: {}, create: c });
  }

  // Settings: create missing keys only. `home` copy stays on code defaults until edited.
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (key === 'home') continue;
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: skipping the OWNER admin.');
  } else {
    if (ADMIN_PASSWORD.length < 12)
      throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    if (isProd && EXAMPLE_ADMIN_PASSWORDS.includes(ADMIN_PASSWORD)) {
      throw new Error(
        'ADMIN_PASSWORD is the example value. Choose a real password for production.',
      );
    }
    const email = ADMIN_EMAIL.trim().toLowerCase();
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (!existing) {
      await prisma.admin.create({
        data: {
          email,
          name: ADMIN_NAME || 'Owner',
          role: 'OWNER',
          passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
        },
      });
      console.log(`Created OWNER admin ${email}`);
    } else {
      console.log(`Admin ${email} already exists: password left unchanged.`);
    }
  }

  console.log(`Base seed: ${categories.length} categories, default settings.`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
