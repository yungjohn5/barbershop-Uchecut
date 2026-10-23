// Admin views of bookings: list/filter, detail, status changes, today, week calendar.
const prisma = require('../lib/prisma');
const { HttpError } = require('../lib/errors');
const { ACTIVE_STATUSES } = require('../config/constants');
const { wallClockToUtc, addDays, toShopDate, weekdayOf, isValidDateStr } = require('../lib/time');

const DAY_MS = 86_400_000;
const include = { services: true, barber: true, customer: true, zone: true };

// ---------------------------------------------------------------------------
// Status rules (pure)
// ---------------------------------------------------------------------------

/**
 * Actions staff may take on a booking right now.
 *  confirm   PENDING → CONFIRMED
 *  complete  CONFIRMED → COMPLETED   (once the appointment has started)
 *  noShow    CONFIRMED → NO_SHOW     (once it has started; bumps the customer's count)
 *  cancel    PENDING|CONFIRMED → CANCELLED
 *  undo      COMPLETED|NO_SHOW → CONFIRMED (mistakes, within 7 days of the appointment)
 *  reschedule PENDING|CONFIRMED before it starts
 */
function allowedActions(booking, now) {
  const started = booking.startsAt.getTime() <= now.getTime();
  const recent = now.getTime() - booking.startsAt.getTime() < 7 * DAY_MS;
  const out = [];
  if (booking.status === 'PENDING') out.push('confirm');
  if (booking.status === 'CONFIRMED' && started) out.push('complete', 'noShow');
  if (['PENDING', 'CONFIRMED'].includes(booking.status) && !started) out.push('reschedule');
  if (['PENDING', 'CONFIRMED'].includes(booking.status)) out.push('cancel');
  if (['COMPLETED', 'NO_SHOW'].includes(booking.status) && recent) out.push('undo');
  return out;
}

/** Pure: the update + customer no-show delta for an action. */
function transitionFor(booking, action, { now, reason }) {
  switch (action) {
    case 'confirm':
      return { data: { status: 'CONFIRMED', confirmedAt: now }, noShowDelta: 0 };
    case 'complete':
      return { data: { status: 'COMPLETED' }, noShowDelta: 0 };
    case 'noShow':
      return { data: { status: 'NO_SHOW' }, noShowDelta: 1 };
    case 'cancel':
      return {
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelReason: (reason && String(reason).trim().slice(0, 300)) || 'Cancelled by staff',
        },
        noShowDelta: 0,
      };
    case 'undo':
      return {
        data: { status: 'CONFIRMED' },
        noShowDelta: booking.status === 'NO_SHOW' ? -1 : 0,
      };
    default:
      throw new HttpError(400, 'Unknown action.');
  }
}

const ACTION_DONE = {
  confirm: 'Booking confirmed.',
  complete: 'Marked as completed.',
  noShow: 'Marked as a no-show.',
  cancel: 'Booking cancelled.',
  undo: 'Status restored to confirmed.',
};

const EVENT_FOR = {
  confirm: 'CONFIRMED',
  complete: 'COMPLETED',
  noShow: 'NO_SHOW',
  cancel: 'CANCELLED',
  undo: 'RESTORED',
};

async function applyAction(id, action, { now = new Date(), reason, adminName, db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id } });
    if (!booking) throw new HttpError(404, 'Booking not found.');
    if (!allowedActions(booking, now).includes(action) || action === 'reschedule') {
      throw new HttpError(409, 'That action isn’t available for this booking right now.');
    }
    const { data, noShowDelta } = transitionFor(booking, action, { now, reason });
    const event = {
      type: EVENT_FOR[action],
      actor: 'STAFF',
      byName: adminName || null,
      note: action === 'cancel' ? data.cancelReason : null,
    };
    const updated = await tx.booking.update({
      where: { id },
      data: { ...data, events: { create: event } },
      include,
    });
    if (noShowDelta) {
      const c = await tx.customer.findUnique({ where: { id: booking.customerId } });
      await tx.customer.update({
        where: { id: booking.customerId },
        data: { noShowCount: Math.max(0, c.noShowCount + noShowDelta) },
      });
    }
    return { booking: updated, message: ACTION_DONE[action] };
  });
}

async function updateStaffNotes(id, notes, { db = prisma } = {}) {
  const text = String(notes || '')
    .trim()
    .slice(0, 2000);
  return db.booking.update({ where: { id }, data: { staffNotes: text || null } });
}

async function getBooking(id, { db = prisma } = {}) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.booking.findUnique({
    where: { id },
    include: { ...include, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
}

// ---------------------------------------------------------------------------
// List with filters
// ---------------------------------------------------------------------------

const SCOPES = ['upcoming', 'today', 'pending', 'past', 'all'];

/** Pure-ish: Prisma `where` from filters (today = shop calendar day). */
function listWhere(f, now) {
  const where = {};
  const today = toShopDate(now);
  const dayStart = wallClockToUtc(today, 0);
  const dayEnd = wallClockToUtc(addDays(today, 1), 0);
  switch (f.scope) {
    case 'today':
      where.startsAt = { gte: dayStart, lt: dayEnd };
      break;
    case 'pending':
      where.status = 'PENDING';
      where.startsAt = { gte: now };
      break;
    case 'past':
      where.startsAt = { lt: now };
      break;
    case 'all':
      break;
    default: // upcoming
      where.startsAt = { gte: dayStart };
      where.status = { in: ACTIVE_STATUSES };
  }
  if (isValidDateStr(f.from) || isValidDateStr(f.to)) {
    where.startsAt = {
      ...(isValidDateStr(f.from) ? { gte: wallClockToUtc(f.from, 0) } : {}),
      ...(isValidDateStr(f.to) ? { lt: wallClockToUtc(addDays(f.to, 1), 0) } : {}),
    };
  }
  if (f.barberId) where.barberId = f.barberId;
  if (f.type === 'SHOP' || f.type === 'HOME') where.type = f.type;
  if (['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(f.status))
    where.status = f.status;
  const q = String(f.q || '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    where.OR = [
      { reference: { contains: q.toUpperCase() } },
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      ...(digits.length >= 4
        ? [{ customer: { phone: { contains: digits.replace(/^0/, '') } } }]
        : []),
    ];
  }
  return where;
}

async function listBookings(
  filters,
  { now = new Date(), page = 1, pageSize = 25, db = prisma } = {},
) {
  const scope = SCOPES.includes(filters.scope) ? filters.scope : 'upcoming';
  const where = listWhere({ ...filters, scope }, now);
  const orderBy = scope === 'past' || scope === 'all' ? { startsAt: 'desc' } : { startsAt: 'asc' };
  const [total, rows] = await Promise.all([
    db.booking.count({ where }),
    db.booking.findMany({ where, orderBy, include, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / pageSize)), scope };
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

async function todayOverview({ now = new Date(), db = prisma } = {}) {
  const today = toShopDate(now);
  const dayStart = wallClockToUtc(today, 0);
  const dayEnd = wallClockToUtc(addDays(today, 1), 0);
  // Monday-start week in shop time.
  const wd = weekdayOf(today);
  const weekStart = wallClockToUtc(addDays(today, -((wd + 6) % 7)), 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);

  const [todays, pending, weekCount, barbers] = await Promise.all([
    db.booking.findMany({
      where: { startsAt: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } },
      orderBy: { startsAt: 'asc' },
      include,
    }),
    db.booking.findMany({
      where: { status: 'PENDING', startsAt: { gte: now } },
      orderBy: { startsAt: 'asc' },
      include,
      take: 6,
    }),
    db.booking.count({
      where: { startsAt: { gte: weekStart, lt: weekEnd }, status: { not: 'CANCELLED' } },
    }),
    // Active barbers, plus any inactive barber who still has bookings today.
    db.barber.findMany({
      where: {
        OR: [
          { active: true },
          {
            bookings: {
              some: { startsAt: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } },
            },
          },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { hours: { where: { weekday: wd } } },
    }),
  ]);
  const pendingTotal = await db.booking.count({
    where: { status: 'PENDING', startsAt: { gte: now } },
  });

  const sum = (list) => list.reduce((s, b) => s + b.totalKobo, 0);
  const done = todays.filter((b) => b.status === 'COMPLETED');
  const next =
    todays.find((b) => b.startsAt > now && ['PENDING', 'CONFIRMED'].includes(b.status)) || null;
  return {
    today,
    now,
    stats: {
      todayCount: todays.length,
      todayDone: done.length,
      expectedKobo: sum(todays.filter((b) => b.status !== 'NO_SHOW')),
      takenKobo: sum(done),
      pendingTotal,
      weekCount,
    },
    pending,
    next,
    lanes: barbers.map((b) => ({
      barber: b,
      working: b.hours.length > 0,
      bookings: todays.filter((x) => x.barberId === b.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Week calendar
// ---------------------------------------------------------------------------

/** Monday of the week containing `date` (shop calendar). */
function weekStartOf(date) {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/**
 * Week grid for one barber: days with events positioned in minutes from midnight, the
 * shift for each day, and time off. Range of the time axis covers shifts and bookings.
 */
async function weekCalendar({ date, barberId, now = new Date(), db = prisma }) {
  const start = weekStartOf(isValidDateStr(date) ? date : toShopDate(now));
  const from = wallClockToUtc(start, 0);
  const to = wallClockToUtc(addDays(start, 7), 0);
  // Active barbers, plus inactive ones who still have bookings from this week on, so
  // their appointments never vanish from the calendar.
  const barbers = await db.barber.findMany({
    where: {
      OR: [
        { active: true },
        { bookings: { some: { startsAt: { gte: from }, status: { in: ACTIVE_STATUSES } } } },
        { bookings: { some: { startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } } } },
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const barber = barbers.find((b) => b.id === barberId) || barbers[0] || null;
  if (!barber)
    return {
      start,
      end: addDays(start, 6),
      days: [],
      barbers,
      barber: null,
      axis: { from: 540, to: 1260 },
      nowMin: null,
    };

  const [bookings, hours, timeOff] = await Promise.all([
    db.booking.findMany({
      where: {
        barberId: barber.id,
        blockStartsAt: { lt: to },
        blockEndsAt: { gt: from },
        status: { not: 'CANCELLED' },
      },
      include: { customer: true, services: true, zone: true },
      orderBy: { startsAt: 'asc' },
    }),
    db.workingHours.findMany({ where: { barberId: barber.id } }),
    db.timeOff.findMany({
      where: { barberId: barber.id, startsAt: { lt: to }, endsAt: { gt: from } },
    }),
  ]);

  const minuteOf = (instant, day) =>
    Math.round((instant.getTime() - wallClockToUtc(day, 0).getTime()) / 60_000);
  let axisFrom = 600;
  let axisTo = 1200;
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(start, i);
    const wd = weekdayOf(day);
    const shifts = hours
      .filter((h) => h.weekday === wd)
      .map((h) => ({ from: h.startMin, to: h.endMin }));
    shifts.forEach((s) => {
      axisFrom = Math.min(axisFrom, s.from);
      axisTo = Math.max(axisTo, s.to);
    });
    const events = bookings
      .filter((b) => toShopDate(b.startsAt) === day)
      .map((b) => {
        const e = {
          booking: b,
          blockFrom: Math.max(0, minuteOf(b.blockStartsAt, day)),
          from: minuteOf(b.startsAt, day),
          to: minuteOf(b.endsAt, day),
          blockTo: Math.min(1440, minuteOf(b.blockEndsAt, day)),
        };
        axisFrom = Math.min(axisFrom, e.blockFrom);
        axisTo = Math.max(axisTo, e.blockTo);
        return e;
      });
    const off = timeOff
      .map((t) => ({
        from: Math.max(0, minuteOf(t.startsAt, day)),
        to: Math.min(1440, minuteOf(t.endsAt, day)),
        reason: t.reason,
      }))
      .filter((t) => t.to > 0 && t.from < 1440);
    return { date: day, weekday: wd, isToday: day === toShopDate(now), shifts, events, off };
  });
  // Round the axis to whole hours with a little air.
  const axis = {
    from: Math.max(0, Math.floor(axisFrom / 60) * 60 - 60),
    to: Math.min(1440, Math.ceil(axisTo / 60) * 60 + 60),
  };
  const nowMin =
    toShopDate(now) >= start && toShopDate(now) < addDays(start, 7)
      ? minuteOf(now, toShopDate(now))
      : null;
  return { start, end: addDays(start, 6), days, barbers, barber, axis, nowMin };
}

module.exports = {
  allowedActions,
  transitionFor,
  applyAction,
  updateStaffNotes,
  getBooking,
  listWhere,
  listBookings,
  todayOverview,
  weekCalendar,
  weekStartOf,
  SCOPES,
};
