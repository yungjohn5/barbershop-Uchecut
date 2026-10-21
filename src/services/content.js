// Read models for the public marketing pages.
const prisma = require('../lib/prisma');
const settingsService = require('./settings');
const { formatInTimeZone } = require('date-fns-tz');
const { TIMEZONE } = require('../config/constants');
const { minutesToHHMM } = require('../lib/time');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Pure: is the shop open right now, from the union of active barbers' weekly hours?
 * hours: [{ weekday, startMin, endMin }] in shop wall-clock minutes.
 * Returns { open, label } e.g. "Open now · until 20:00" / "Closed · opens tomorrow 10:00".
 */
function shopStatus({ now, hours, tz = TIMEZONE }) {
  if (!hours.length) return { open: false, label: 'Opening hours coming soon' };
  const weekday = Number(formatInTimeZone(now, tz, 'i')) % 7; // ISO 1-7 → 0 = Sunday
  const nowMin =
    Number(formatInTimeZone(now, tz, 'H')) * 60 + Number(formatInTimeZone(now, tz, 'm'));

  const today = hours.filter((h) => h.weekday === weekday);
  const current = today.filter((h) => h.startMin <= nowMin && nowMin < h.endMin);
  if (current.length) {
    const until = Math.max(...current.map((h) => h.endMin));
    return { open: true, label: `Open now · until ${minutesToHHMM(until)}` };
  }
  for (let offset = 0; offset < 7; offset += 1) {
    const day = (weekday + offset) % 7;
    const starts = hours
      .filter((h) => h.weekday === day && (offset > 0 || h.startMin > nowMin))
      .map((h) => h.startMin);
    if (starts.length) {
      const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : DAY_NAMES[day];
      return { open: false, label: `Closed · opens ${when} ${minutesToHHMM(Math.min(...starts))}` };
    }
  }
  return { open: false, label: 'Closed' };
}

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

async function getHomeContent({ db = prisma, now = new Date() } = {}) {
  const [settings, categories, barbers, zones, products, hours] = await Promise.all([
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
    db.workingHours.findMany({
      where: { barber: { active: true } },
      select: { weekday: true, startMin: true, endMin: true },
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
    status: shopStatus({ now, hours }),
  };
}

module.exports = { getHomeContent, homeFacts, shopStatus };
