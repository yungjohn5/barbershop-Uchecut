// Availability engine. computeSlots() and the helpers above it are pure (no DB,
// no clock) and unit-tested; getSlots() loads data with Prisma and calls them.
const prisma = require('../lib/prisma');
const { ValidationError } = require('../lib/errors');
const { ACTIVE_STATUSES } = require('../config/constants');
const settingsService = require('./settings');
const {
  isValidDateStr,
  wallClockToUtc,
  weekdayOf,
  addDays,
  diffDays,
  toShopDate,
  toShopTime,
} = require('../lib/time');

const MIN = 60_000;

/**
 * Barbers who can perform every requested service (and do home visits, for HOME).
 * barbers: [{ id, active, doesHomeService, serviceIds: number[] }]
 */
function eligibleBarbers(barbers, serviceIds, type) {
  return barbers.filter(
    (b) =>
      b.active !== false &&
      (type !== 'HOME' || b.doesHomeService) &&
      serviceIds.every((id) => b.serviceIds.includes(id)),
  );
}

/**
 * Validate a service/zone selection and derive the booking's timing and price.
 * services: [{ id, name, priceKobo, durationMin, homeAvailable }]
 */
function summariseSelection({ type, services, zone }) {
  if (!services.length) throw new ValidationError('Choose at least one service.');
  if (type === 'HOME') {
    if (!zone) throw new ValidationError('Choose a zone for a home visit.');
    const shopOnly = services.filter((s) => !s.homeAvailable);
    if (shopOnly.length) {
      const err = new ValidationError(
        `Not available for home visits: ${shopOnly.map((s) => s.name).join(', ')}.`,
        shopOnly.map((s) => ({ path: 'serviceIds', serviceId: s.id, message: 'In shop only' })),
      );
      err.code = 'HOME_NOT_AVAILABLE';
      throw err;
    }
  }
  const serviceMin = services.reduce((sum, s) => sum + s.durationMin, 0);
  const subtotalKobo = services.reduce((sum, s) => sum + s.priceKobo, 0);
  const homeFeeKobo = type === 'HOME' ? zone.feeKobo : 0;
  return {
    serviceMin,
    bufferMin: type === 'HOME' ? zone.travelBufferMin : 0,
    subtotalKobo,
    homeFeeKobo,
    totalKobo: subtotalKobo + homeFeeKobo,
  };
}

/**
 * Pure slot generator.
 *
 * @param {object} p
 * @param {string} p.date          'YYYY-MM-DD' shop calendar day
 * @param {Date}   p.now           current instant (injected for testability)
 * @param {'SHOP'|'HOME'} p.type
 * @param {number} p.serviceMin    total service minutes
 * @param {number} p.bufferMin     travel buffer, applied before AND after (0 for SHOP)
 * @param {Array}  p.barbers       [{ id, shifts: [{ startMin, endMin }], blocks: [{ start: Date, end: Date }] }]
 *                                 blocks = active bookings' block ranges + time off
 * @param {object} p.settings      { leadTimeShopMin, leadTimeHomeMin, bookingWindowDays, slotStepMin, allowBufferOutsideShift }
 * @returns {Array<{ time: string, startsAt: string, barberIds: number[] }>}
 */
function computeSlots({ date, now, type, serviceMin, bufferMin, barbers, settings }) {
  if (!isValidDateStr(date) || serviceMin <= 0) return [];

  const today = toShopDate(now);
  const daysAhead = diffDays(today, date);
  if (daysAhead < 0 || daysAhead > settings.bookingWindowDays) return [];

  const leadMin = type === 'HOME' ? settings.leadTimeHomeMin : settings.leadTimeShopMin;
  const earliest = now.getTime() + leadMin * MIN;
  const step = settings.slotStepMin;
  const svc = serviceMin * MIN;
  const buf = bufferMin * MIN;

  const byStart = new Map(); // startsAt ms → Set(barberId)

  for (const barber of barbers) {
    const blocks = barber.blocks.map((b) => [b.start.getTime(), b.end.getTime()]);

    for (const shift of barber.shifts) {
      const shiftStart = wallClockToUtc(date, shift.startMin).getTime();
      const shiftEnd = wallClockToUtc(date, shift.endMin).getTime();

      for (let s = shiftStart; s < shiftEnd; s += step * MIN) {
        const blockStart = s - buf;
        const blockEnd = s + svc + buf;

        // Busy window must sit inside the shift (or just the service, if buffers may spill).
        const fits = settings.allowBufferOutsideShift
          ? s >= shiftStart && s + svc <= shiftEnd
          : blockStart >= shiftStart && blockEnd <= shiftEnd;
        if (!fits) continue;
        if (s < earliest) continue;
        // Half-open overlap: [a,b) ∩ [c,d) ≠ ∅ ⇔ a < d && c < b.
        if (blocks.some(([bs, be]) => bs < blockEnd && blockStart < be)) continue;

        if (!byStart.has(s)) byStart.set(s, new Set());
        byStart.get(s).add(barber.id);
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([s, ids]) => ({
      time: toShopTime(new Date(s)),
      startsAt: new Date(s).toISOString(),
      barberIds: [...ids].sort((a, b) => a - b),
    }));
}

/**
 * "Any barber": the candidate with the fewest active bookings that day; ties → lowest id.
 * counts: { [barberId]: number }
 */
function pickLeastBusy(candidateIds, counts) {
  return [...candidateIds].sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0) || a - b)[0];
}

// ---------------------------------------------------------------------------
// Data loading (Prisma). `db` may be a transaction client.
// ---------------------------------------------------------------------------

async function loadSelection(db, { type, serviceIds, zoneId }) {
  const uniqueIds = [...new Set(serviceIds)];
  const services = await db.service.findMany({ where: { id: { in: uniqueIds }, active: true } });
  if (services.length !== uniqueIds.length) {
    throw new ValidationError('One or more services are unavailable.');
  }
  // Keep the customer's order for display and snapshots.
  services.sort((a, b) => uniqueIds.indexOf(a.id) - uniqueIds.indexOf(b.id));

  let zone = null;
  if (type === 'HOME') {
    if (zoneId == null) throw new ValidationError('Choose a zone for a home visit.');
    zone = await db.zone.findFirst({ where: { id: zoneId, active: true } });
    if (!zone) throw new ValidationError('That zone is not available.');
  }
  return { services, zone, ...summariseSelection({ type, services, zone }) };
}

/**
 * Load everything computeSlots needs for one day and run it.
 * Returns { slots, selection, barbers } so booking.js can reuse the context.
 */
/**
 * excludeBookingId: ignore this booking's own block (rescheduling must not collide with itself).
 */
async function computeDay(
  db,
  { date, barberId, serviceIds, type, zoneId, excludeBookingId = null },
  { now, settings },
) {
  if (!isValidDateStr(date)) throw new ValidationError('Invalid date.');
  const selection = await loadSelection(db, { type, serviceIds, zoneId });
  const weekday = weekdayOf(date);

  const rows = await db.barber.findMany({
    where: { active: true, ...(barberId !== 'any' ? { id: barberId } : {}) },
    include: {
      services: { select: { serviceId: true } },
      hours: { where: { weekday }, select: { startMin: true, endMin: true } },
    },
    orderBy: { id: 'asc' },
  });
  const candidates = eligibleBarbers(
    rows.map((b) => ({ ...b, serviceIds: b.services.map((s) => s.serviceId) })),
    selection.services.map((s) => s.id),
    type,
  );
  if (barberId !== 'any' && !candidates.length) {
    throw new ValidationError('That barber does not offer this booking.');
  }

  // Anything that could touch a candidate block on this day (blocks can spill by the buffer).
  const pad = (selection.bufferMin + 1) * MIN;
  const from = new Date(wallClockToUtc(date, 0).getTime() - pad);
  const to = new Date(wallClockToUtc(addDays(date, 1), 0).getTime() + pad);
  const ids = candidates.map((b) => b.id);

  const [bookings, timeOff] = ids.length
    ? await Promise.all([
        db.booking.findMany({
          where: {
            barberId: { in: ids },
            status: { in: ACTIVE_STATUSES },
            ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
            blockStartsAt: { lt: to },
            blockEndsAt: { gt: from },
          },
          select: { barberId: true, blockStartsAt: true, blockEndsAt: true },
        }),
        db.timeOff.findMany({
          where: { barberId: { in: ids }, startsAt: { lt: to }, endsAt: { gt: from } },
          select: { barberId: true, startsAt: true, endsAt: true },
        }),
      ])
    : [[], []];

  const engineBarbers = candidates.map((b) => ({
    id: b.id,
    shifts: b.hours,
    blocks: [
      ...bookings
        .filter((x) => x.barberId === b.id)
        .map((x) => ({ start: x.blockStartsAt, end: x.blockEndsAt })),
      ...timeOff
        .filter((x) => x.barberId === b.id)
        .map((x) => ({ start: x.startsAt, end: x.endsAt })),
    ],
  }));

  const slots = computeSlots({
    date,
    now,
    type,
    serviceMin: selection.serviceMin,
    bufferMin: selection.bufferMin,
    barbers: engineBarbers,
    settings,
  });
  return { slots, selection, candidates };
}

/** Public entry point used by GET /api/slots. */
async function getSlots(query, { now = new Date(), db = prisma } = {}) {
  const settings = await settingsService.getAll();
  const { slots, selection } = await computeDay(db, query, { now, settings });
  return {
    date: query.date,
    type: query.type,
    serviceMin: selection.serviceMin,
    bufferMin: selection.bufferMin,
    subtotalKobo: selection.subtotalKobo,
    homeFeeKobo: selection.homeFeeKobo,
    totalKobo: selection.totalKobo,
    slots,
  };
}

module.exports = {
  eligibleBarbers,
  summariseSelection,
  computeSlots,
  pickLeastBusy,
  loadSelection,
  computeDay,
  getSlots,
};
