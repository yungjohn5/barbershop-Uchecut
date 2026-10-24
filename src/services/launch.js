// Launch readiness: what is still placeholder content (defaults, stock photos, missing
// details) before the site goes live. Shown to owners on the dashboard until it's empty;
// docs/LAUNCH-CONTENT.md is the human checklist this mirrors.
const prisma = require('../lib/prisma');
const settingsService = require('./settings');
const { DEFAULT_SETTINGS } = require('../config/constants');
const { imageOf, SITE_SLOTS } = require('../lib/images');

const REQUIRED = 'required';
const RECOMMENDED = 'recommended';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Bundled stock photos live in /images/site; anything uploaded is on Cloudinary.
const isStock = (img) => !img || Boolean(img.legacy && img.legacy.startsWith('/images/site/'));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Pure: list of gaps, most important first.
 * Each gap: { key, level: 'required'|'recommended', label, href }.
 */
function contentGaps({
  settings,
  defaults = DEFAULT_SETTINGS,
  services = [],
  barbers = [],
  products = [],
  zones = [],
  hours = [],
}) {
  const gaps = [];
  const add = (key, level, label, href) => gaps.push({ key, level, label, href });
  const shop = settings.shop || {};
  const d = defaults.shop;

  // Shop details: the defaults are placeholders, never real.
  if (same(shop.address, d.address))
    add('address', REQUIRED, 'Add the shop address', '/admin/settings#shop');
  if (shop.phone === d.phone)
    add('phone', REQUIRED, 'Add the shop phone number', '/admin/settings#shop');
  if (shop.whatsapp === d.whatsapp)
    add('whatsapp', REQUIRED, 'Add the WhatsApp number', '/admin/settings#shop');
  if (!shop.email || /@example\.(com|org|net)$/i.test(shop.email))
    add('email', REQUIRED, 'Add the shop email', '/admin/settings#shop');

  // Bookable catalogue.
  const activeServices = services.filter((s) => s.active);
  const activeBarbers = barbers.filter((b) => b.active);
  if (!activeServices.length)
    add('services', REQUIRED, 'Add at least one service', '/admin/services');
  if (!activeBarbers.length) add('barbers', REQUIRED, 'Add at least one barber', '/admin/barbers');
  const withHours = new Set(hours.map((h) => h.barberId));
  const noHours = activeBarbers.filter((b) => !withHours.has(b.id));
  if (noHours.length)
    add(
      'hours',
      REQUIRED,
      `Set working hours for ${noHours.map((b) => b.name).join(', ')}`,
      `/admin/barbers/${noHours[0].id}`,
    );

  // Photos: stock placeholders and empty slots.
  const stockSlots = Object.keys(SITE_SLOTS).filter((slot) => !(settings.siteImages || {})[slot]);
  if (stockSlots.length)
    add(
      'site-photos',
      RECOMMENDED,
      `Upload real site photos (${plural(stockSlots.length, 'placeholder')} left)`,
      '/admin/settings#photos',
    );
  const stockBarbers = activeBarbers.filter((b) => isStock(imageOf(b, 'photo')));
  if (stockBarbers.length)
    add(
      'barber-photos',
      RECOMMENDED,
      `Barber photos: ${stockBarbers.map((b) => b.name).join(', ')}`,
      `/admin/barbers/${stockBarbers[0].id}`,
    );
  const stockServices = activeServices.filter((s) => isStock(imageOf(s)));
  if (stockServices.length)
    add(
      'service-photos',
      RECOMMENDED,
      `Service photos (${plural(stockServices.length, 'service')} on stock or no photo)`,
      '/admin/services',
    );
  const stockProducts = products.filter((p) => p.visible && isStock(imageOf(p)));
  if (stockProducts.length)
    add(
      'product-photos',
      RECOMMENDED,
      `Product photos (${plural(stockProducts.length, 'product')} on stock or no photo)`,
      '/admin/products',
    );

  // Words and extras.
  const noBio = activeBarbers.filter((b) => !b.bio);
  if (noBio.length)
    add(
      'bios',
      RECOMMENDED,
      `Write a short bio for ${noBio.map((b) => b.name).join(', ')}`,
      `/admin/barbers/${noBio[0].id}`,
    );
  if (same(settings.home, defaults.home))
    add(
      'copy',
      RECOMMENDED,
      'Review the home page wording (still the starter text)',
      '/admin/settings#home',
    );
  if (same(shop.hoursText, d.hoursText))
    add(
      'hours-text',
      RECOMMENDED,
      'Check the opening-hours text in the footer',
      '/admin/settings#shop',
    );
  if (!Number.isFinite(shop.lat))
    add(
      'map-pin',
      RECOMMENDED,
      'Add the map pin so Google can place the shop',
      '/admin/settings#shop',
    );
  if (!Object.values(shop.socials || {}).some(Boolean))
    add('socials', RECOMMENDED, 'Add social links (Instagram, TikTok…)', '/admin/settings#shop');
  if (!zones.some((z) => z.active))
    add(
      'zones',
      RECOMMENDED,
      'Add home-visit zones (home visits stay hidden until then)',
      '/admin/zones',
    );

  return gaps.sort((a, b) => (a.level === b.level ? 0 : a.level === REQUIRED ? -1 : 1));
}

async function launchChecklist({ db = prisma } = {}) {
  const [settings, services, barbers, products, zones, hours] = await Promise.all([
    settingsService.getAll(),
    db.service.findMany(),
    db.barber.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.product.findMany(),
    db.zone.findMany(),
    db.workingHours.findMany({ select: { barberId: true } }),
  ]);
  return contentGaps({ settings, services, barbers, products, zones, hours });
}

module.exports = { contentGaps, launchChecklist, REQUIRED, RECOMMENDED };
