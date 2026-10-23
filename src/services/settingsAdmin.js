// Owner-editable settings, saved section by section into the Setting table.
// Times are typed in hours and stored in minutes, matching services/settings.js.
const { z } = require('zod');
const prisma = require('../lib/prisma');
const settings = require('./settings');
const { DEFAULT_SETTINGS } = require('../config/constants');
const { parse } = require('./catalog');

const trimmed = (max, label) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : ''),
    z.string().min(1, `Enter ${label}.`).max(max, `Keep ${label} under ${max} characters.`),
  );
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : ''),
  z.union([
    z.literal(''),
    z
      .string()
      .url('Use a full link starting with https://')
      .startsWith('https://', 'Use a link starting with https://')
      .max(200),
  ]),
);
/** Textarea → non-empty trimmed lines. */
const lines = (min, max, each, label) =>
  z.preprocess(
    (v) =>
      String(v || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    z
      .array(z.string().max(each, `Keep each ${label} line under ${each} characters.`))
      .min(min, `Add at least ${min} ${label} line${min > 1 ? 's' : ''}.`)
      .max(max, `Use at most ${max} ${label} lines.`),
  );
const hours = (min, max, label) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? Number.NaN : Number(v)),
    z
      .number({ invalid_type_error: `Enter ${label} in hours.` })
      .min(min, `${label[0].toUpperCase()}${label.slice(1)} must be ${min}–${max} hours.`)
      .max(max, `${label[0].toUpperCase()}${label.slice(1)} must be ${min}–${max} hours.`)
      .refine((n) => Number.isInteger(n * 4), 'Use quarter hours, e.g. 1.5 or 0.25.')
      .transform((n) => Math.round(n * 60)),
  );

const SCHEMAS = {
  booking: z.object({
    leadTimeShopMin: hours(0, 72, 'shop lead time'),
    leadTimeHomeMin: hours(0, 168, 'home lead time'),
    cancelCutoffMin: hours(0, 72, 'the cancellation cutoff'),
    homeAutoCancelHours: z.preprocess(
      (v) => Number(v),
      z
        .number({ invalid_type_error: 'Enter hours.' })
        .int('Use whole hours.')
        .min(1, 'Use 1–72 hours.')
        .max(72, 'Use 1–72 hours.'),
    ),
    bookingWindowDays: z.preprocess(
      (v) => Number(v),
      z
        .number({ invalid_type_error: 'Enter days.' })
        .int('Use whole days.')
        .min(1, 'Use 1–180 days.')
        .max(180, 'Use 1–180 days.'),
    ),
    slotStepMin: z.preprocess(
      (v) => Number(v),
      z.union(
        [5, 10, 15, 20, 30, 60].map((n) => z.literal(n)),
        { errorMap: () => ({ message: 'Choose a slot step.' }) },
      ),
    ),
    allowBufferOutsideShift: z.preprocess((v) => v === 'on' || v === 'true', z.boolean()),
  }),
  shop: z.object({
    name: trimmed(60, 'the shop name'),
    tagline: trimmed(120, 'a tagline'),
    address: lines(1, 4, 80, 'address'),
    phone: z.preprocess(
      (v) => String(v || '').replace(/[\s()-]/g, ''),
      z.string().regex(/^\+?\d{7,15}$/, 'Enter a phone number, e.g. +2348031234567.'),
    ),
    whatsapp: z.preprocess(
      (v) => String(v || '').replace(/\D/g, ''),
      z
        .string()
        .regex(/^\d{10,15}$/, 'Enter the WhatsApp number with country code, e.g. 2348031234567.'),
    ),
    email: z.preprocess(
      (v) =>
        String(v || '')
          .trim()
          .toLowerCase(),
      z.string().email('Enter a valid email.').max(120),
    ),
    hoursText: lines(1, 7, 60, 'opening-hours'),
    instagram: optionalUrl,
    tiktok: optionalUrl,
    x: optionalUrl,
    youtube: optionalUrl,
    showBuilderSection: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    showBuilderCredit: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  }),
  home: z.object({
    heroLines: lines(3, 3, 40, 'hero'),
    heroText: trimmed(400, 'the hero text'),
    introTitle: trimmed(90, 'the intro title'),
    introText: trimmed(600, 'the intro text'),
    servicesTitle: trimmed(90, 'the services title'),
    servicesText: trimmed(400, 'the services text'),
    craftTitle: trimmed(120, 'the craft title'),
    craftText: trimmed(500, 'the craft text'),
    craftNote: trimmed(200, 'the craft note'),
    barbersTitle: trimmed(90, 'the barbers title'),
    homeTitle: trimmed(90, 'the home-visit title'),
    homeText: trimmed(400, 'the home-visit text'),
    productsTitle: trimmed(90, 'the products title'),
    productsText: trimmed(400, 'the products text'),
    footerText: trimmed(200, 'the footer text'),
  }),
};

/** Pure: validated form → Setting rows [{ key, value }]. */
function rowsFor(section, body) {
  const schema = SCHEMAS[section];
  if (!schema) throw new Error(`Unknown settings section: ${section}`);
  const data = parse(schema, body);
  if (section === 'booking') return Object.entries(data).map(([key, value]) => ({ key, value }));
  if (section === 'shop') {
    const { instagram, tiktok, x, youtube, ...rest } = data;
    return [{ key: 'shop', value: { ...rest, socials: { instagram, tiktok, x, youtube } } }];
  }
  return [{ key: 'home', value: data }];
}

async function saveSection(section, body, { db = prisma } = {}) {
  const rows = rowsFor(section, body);
  await db.$transaction(
    rows.map(({ key, value }) =>
      db.setting.upsert({ where: { key }, update: { value }, create: { key, value } }),
    ),
  );
  settings.invalidate();
  return rows;
}

/** Restore one section to the built-in defaults (removes the stored rows). */
async function resetSection(section, { db = prisma } = {}) {
  const keys =
    section === 'booking'
      ? [
          'leadTimeShopMin',
          'leadTimeHomeMin',
          'cancelCutoffMin',
          'homeAutoCancelHours',
          'bookingWindowDays',
          'slotStepMin',
          'allowBufferOutsideShift',
        ]
      : [section];
  if (!keys.every((k) => k in DEFAULT_SETTINGS))
    throw new Error(`Unknown settings section: ${section}`);
  await db.setting.deleteMany({ where: { key: { in: keys } } });
  settings.invalidate();
}

/** Current values shaped for the forms. */
function formValues(all) {
  const h = (min) => String(Math.round((min / 60) * 100) / 100);
  return {
    booking: {
      leadTimeShopMin: h(all.leadTimeShopMin),
      leadTimeHomeMin: h(all.leadTimeHomeMin),
      cancelCutoffMin: h(all.cancelCutoffMin),
      homeAutoCancelHours: all.homeAutoCancelHours,
      bookingWindowDays: all.bookingWindowDays,
      slotStepMin: all.slotStepMin,
      allowBufferOutsideShift: all.allowBufferOutsideShift,
    },
    shop: {
      ...all.shop,
      address: all.shop.address.join('\n'),
      hoursText: all.shop.hoursText.join('\n'),
      ...(all.shop.socials || {}),
    },
    home: { ...all.home, heroLines: all.home.heroLines.join('\n') },
  };
}

module.exports = { SCHEMAS, rowsFor, saveSection, resetSection, formValues };
