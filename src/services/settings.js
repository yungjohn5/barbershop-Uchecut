const prisma = require('../lib/prisma');
const { DEFAULT_SETTINGS } = require('../config/constants');

const CACHE_MS = 30_000;
let cache = null;
let cachedAt = 0;

// Numeric settings must be non-negative integers; anything else falls back to the default.
const INT_KEYS = [
  'leadTimeShopMin',
  'leadTimeHomeMin',
  'bookingWindowDays',
  'cancelCutoffMin',
  'homeAutoCancelHours',
  'slotStepMin',
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Pure: merge stored rows over defaults, discarding malformed values.
function resolveSettings(rows) {
  const merged = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of rows) {
    if (!(key in DEFAULT_SETTINGS)) {
      merged[key] = value;
    } else if (INT_KEYS.includes(key)) {
      if (Number.isInteger(value) && value >= 0) merged[key] = value;
    } else if (key === 'allowBufferOutsideShift') {
      if (typeof value === 'boolean') merged[key] = value;
    } else if (isPlainObject(DEFAULT_SETTINGS[key])) {
      // Object settings (shop, home): stored fields override defaults field by field.
      if (isPlainObject(value)) merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  if (merged.slotStepMin < 5) merged.slotStepMin = DEFAULT_SETTINGS.slotStepMin;
  return merged;
}

async function getAll({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await prisma.setting.findMany();
  cache = resolveSettings(rows);
  cachedAt = Date.now();
  return cache;
}

async function get(key) {
  return (await getAll())[key];
}

function invalidate() {
  cache = null;
}

module.exports = { getAll, get, invalidate, resolveSettings };
