// Calendar helpers. Dates are 'YYYY-MM-DD' strings meaning a shop (Africa/Lagos)
// calendar day; instants are JS Dates (UTC). Conversions go through date-fns-tz so
// nothing hard-codes the +01:00 offset.
const { fromZonedTime, formatInTimeZone } = require('date-fns-tz');
const { TIMEZONE } = require('../config/constants');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n) => String(n).padStart(2, '0');

function minutesToHHMM(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// Shop wall-clock time on `date` (minutes from midnight) → UTC instant.
function wallClockToUtc(date, minutes, tz = TIMEZONE) {
  const dayOffset = Math.floor(minutes / 1440);
  const base = dayOffset ? addDays(date, dayOffset) : date;
  return fromZonedTime(`${base}T${minutesToHHMM(minutes % 1440)}:00`, tz);
}

// Weekday (0 = Sunday) of a calendar date string, independent of server timezone.
function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Whole calendar days from `a` to `b` (both 'YYYY-MM-DD').
function diffDays(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

const toShopDate = (instant, tz = TIMEZONE) => formatInTimeZone(instant, tz, 'yyyy-MM-dd');
const toShopTime = (instant, tz = TIMEZONE) => formatInTimeZone(instant, tz, 'HH:mm');

module.exports = {
  isValidDateStr,
  minutesToHHMM,
  wallClockToUtc,
  weekdayOf,
  addDays,
  diffDays,
  toShopDate,
  toShopTime,
};
