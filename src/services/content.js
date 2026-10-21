// Read models for the public marketing pages.
const prisma = require('../lib/prisma');
const settingsService = require('./settings');

/**
 * Pure: headline facts for the hero strip, derived from live data so they never drift.
 * services: [{ priceKobo, homeAvailable }], zones: [{ feeKobo }]
 */
function homeFacts({ services, zones, barbers }) {
  const prices = services.map((s) => s.priceKobo);
  return {
    fromPriceKobo: prices.length ? Math.min(...prices) : null,
    serviceCount: services.length,
    homeServiceCount: services.filter((s) => s.homeAvailable).length,
    zoneCount: zones.length,
    zoneNames: zones.map((z) => z.name),
    homeBarberCount: barbers.filter((b) => b.doesHomeService).length,
  };
}

async function getHomeContent({ db = prisma } = {}) {
  const [settings, categories, barbers, zones, products] = await Promise.all([
    settingsService.getAll(),
    db.serviceCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { services: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
    }),
    db.barber.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.zone.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    db.product.findMany({
      where: { visible: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
  ]);

  const services = categories.flatMap((c) =>
    c.services.map((s) => ({ ...s, categorySlug: c.slug, categoryName: c.name })),
  );

  return {
    copy: settings.home,
    categories: categories.filter((c) => c.services.length),
    services,
    barbers,
    zones,
    products,
    facts: homeFacts({ services, zones, barbers }),
  };
}

module.exports = { getHomeContent, homeFacts };
