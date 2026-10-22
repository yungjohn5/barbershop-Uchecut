// Booking wizard: draft handling, step guards and display helpers. The draft lives in the
// session (req.session.booking) so a refresh never loses the customer's choices.
const { formatInTimeZone } = require('date-fns-tz');
const prisma = require('../lib/prisma');
const { TIMEZONE } = require('../config/constants');
const { addDays, toShopDate, weekdayOf, wallClockToUtc } = require('../lib/time');
const { loadSelection, eligibleBarbers } = require('./availability');
const settingsService = require('./settings');

const STEPS = [
  { key: 'type', path: '/book', label: 'Visit' },
  { key: 'services', path: '/book/services', label: 'Services' },
  { key: 'time', path: '/book/time', label: 'Time' },
  { key: 'details', path: '/book/details', label: 'Details' },
];

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The first step the draft has not completed; later steps are locked until then. */
function nextIncompleteStep(draft = {}) {
  if (!draft.type || (draft.type === 'HOME' && !draft.zoneId)) return 'type';
  if (!Array.isArray(draft.serviceIds) || !draft.serviceIds.length) return 'services';
  if (!draft.startsAt) return 'time';
  return 'details';
}

/** Steps for the progress bar: done / current / upcoming, and whether each is reachable. */
function stepStates(current, draft) {
  const order = STEPS.map((s) => s.key);
  const frontier = order.indexOf(nextIncompleteStep(draft));
  const at = order.indexOf(current);
  return STEPS.map((s, i) => ({
    ...s,
    index: i + 1,
    state: i < at ? 'done' : i === at ? 'current' : 'upcoming',
    reachable: i <= frontier,
  }));
}

/**
 * Apply ?type=&service=&barber= from deep links (service cards, "Book with Tunde") to a
 * draft. Changing the visit type clears choices that may no longer be valid.
 */
function applyPrefill(draft, query = {}) {
  const next = { ...draft };
  const type = String(query.type || '').toUpperCase();
  if (type === 'SHOP' || type === 'HOME') {
    if (next.type && next.type !== type) {
      delete next.zoneId;
      delete next.startsAt;
    }
    next.type = type;
    if (type === 'SHOP') delete next.zoneId;
  }
  const service = Number(query.service);
  if (Number.isInteger(service) && service > 0) {
    next.serviceIds = [service];
    delete next.startsAt;
  }
  const barber = Number(query.barber);
  if (Number.isInteger(barber) && barber > 0) {
    next.barberId = barber;
    delete next.startsAt;
  }
  return next;
}

/**
 * Pure: the scrollable date strip. Days with no shifts at all are marked closed.
 * openWeekdays: Set of weekday numbers (0 = Sunday) that have hours.
 */
function dateStrip({ today, days, openWeekdays }) {
  return Array.from({ length: days + 1 }, (_, i) => {
    const date = addDays(today, i);
    const [, m, d] = date.split('-').map(Number);
    const weekday = weekdayOf(date);
    return {
      date,
      weekday: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : DAY_SHORT[weekday],
      day: d,
      month: MONTH_SHORT[m - 1],
      closed: !openWeekdays.has(weekday),
    };
  });
}

/** Pure: slots grouped for display (Lagos wall-clock "HH:MM"). */
function groupSlots(slots) {
  const groups = [
    { key: 'morning', label: 'Morning', slots: [] },
    { key: 'afternoon', label: 'Afternoon', slots: [] },
    { key: 'evening', label: 'Evening', slots: [] },
  ];
  for (const s of slots) {
    const hour = Number(s.time.slice(0, 2));
    groups[hour < 12 ? 0 : hour < 17 ? 1 : 2].slots.push(s);
  }
  return groups.filter((g) => g.slots.length);
}

/** "Mon 20 Oct · 10:15" in shop time. */
function formatWhen(instant, tz = TIMEZONE) {
  return formatInTimeZone(new Date(instant), tz, "EEE d MMM '·' HH:mm");
}

/** "Monday 20 October" in shop time. */
function formatDay(instant, tz = TIMEZONE) {
  return formatInTimeZone(new Date(instant), tz, 'EEEE d MMMM');
}

function formatTime(instant, tz = TIMEZONE) {
  return formatInTimeZone(new Date(instant), tz, 'HH:mm');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Everything the wizard pages and the summary panel need for the current draft.
 * Invalid choices (inactive service, wrong type) are dropped rather than erroring.
 */
async function loadContext(draft, { db = prisma, now = new Date() } = {}) {
  const settings = await settingsService.getAll();
  const [zones, categories, barberRows, hours] = await Promise.all([
    db.zone.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    db.serviceCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { services: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
    }),
    db.barber.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { services: { select: { serviceId: true } } },
    }),
    db.workingHours.findMany({ where: { barber: { active: true } }, select: { weekday: true } }),
  ]);

  const type = draft.type || null;
  const zone = type === 'HOME' ? zones.find((z) => z.id === draft.zoneId) || null : null;
  const allServices = categories.flatMap((c) => c.services);
  const offered = allServices.filter((s) => type !== 'HOME' || s.homeAvailable);
  const chosenIds = (draft.serviceIds || []).filter((id) => offered.some((s) => s.id === id));

  let selection = null;
  if (type && chosenIds.length && (type === 'SHOP' || zone)) {
    try {
      selection = await loadSelection(db, {
        type,
        serviceIds: chosenIds,
        zoneId: zone ? zone.id : null,
      });
    } catch {
      selection = null;
    }
  }

  const barbers = type
    ? eligibleBarbers(
        barberRows.map((b) => ({ ...b, serviceIds: b.services.map((s) => s.serviceId) })),
        chosenIds,
        type,
      )
    : [];
  const barber =
    typeof draft.barberId === 'number'
      ? barberRows.find((b) => b.id === draft.barberId) || null
      : null;

  return {
    settings,
    type,
    zones,
    zone,
    categories: categories
      .map((c) => ({
        ...c,
        services: c.services.filter((s) => type !== 'HOME' || s.homeAvailable),
      }))
      .filter((c) => c.services.length),
    chosenIds,
    selection,
    barbers,
    barber,
    openWeekdays: new Set(hours.map((h) => h.weekday)),
    today: toShopDate(now),
  };
}

/** First bookable date from today (skips fully closed weekdays). */
function firstOpenDate(today, openWeekdays, window = 30) {
  for (let i = 0; i <= window; i += 1) {
    const d = addDays(today, i);
    if (openWeekdays.has(weekdayOf(d))) return d;
  }
  return today;
}

/**
 * First date (from today, within the window) whose slots are non-empty. `slotsFor(date)`
 * resolves to { slots, error }. Skips closed weekdays without querying; checks at most
 * `maxDays` open days, then falls back to the first open date.
 * Returns { date, result } so the caller can render without a second lookup.
 */
async function firstAvailableDate({ today, window, openWeekdays, slotsFor, maxDays = 14 }) {
  let checked = 0;
  for (let i = 0; i <= window && checked < maxDays; i += 1) {
    const date = addDays(today, i);
    if (!openWeekdays.has(weekdayOf(date))) continue;
    checked += 1;
    const result = await slotsFor(date);
    if (result.slots.length) return { date, result };
  }
  const date = firstOpenDate(today, openWeekdays, window);
  return { date, result: await slotsFor(date) };
}

/** Minutes → instant for a date string (re-exported for routes). */
const atShopTime = wallClockToUtc;

module.exports = {
  STEPS,
  nextIncompleteStep,
  stepStates,
  applyPrefill,
  dateStrip,
  groupSlots,
  formatWhen,
  formatDay,
  formatTime,
  loadContext,
  firstOpenDate,
  firstAvailableDate,
  atShopTime,
};
