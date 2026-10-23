// Owner-managed barbers: profile, services offered, weekly hours and time off.
// Hours are Africa/Lagos wall-clock minutes; time off is stored in UTC.
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../lib/errors');
const { ACTIVE_STATUSES } = require('../config/constants');
const {
  wallClockToUtc,
  isValidDateStr,
  addDays,
  toShopDate,
  minutesToHHMM,
} = require('../lib/time');
const catalog = require('./catalog');
const images = require('./images');

const WEEKDAYS = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [0, 'Sunday'],
];

/** "10:30" → 630; "24:00" → 1440; anything else → null. */
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min)) return null;
  return h * 60 + min;
}

const checkbox = (v) => v === 'on' || v === 'true' || v === '1' || v === true;

const profileSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z
      .string({ invalid_type_error: 'Enter a name.' })
      .min(2, 'Enter a name.')
      .max(60, 'Keep it under 60 characters.'),
  ),
  bio: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    z.string().max(600, 'Keep the bio under 600 characters.').nullable(),
  ),
  specialties: z.preprocess(
    (v) =>
      String(v || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    z.array(z.string().max(40, 'Keep each specialty short.')).max(5, 'Up to 5 specialties.'),
  ),
  doesHomeService: z.preprocess(checkbox, z.boolean()),
  active: z.preprocess(checkbox, z.boolean()),
  serviceIds: z.preprocess(
    (v) =>
      []
        .concat(v ?? [])
        .map(Number)
        .filter((n) => n > 0),
    z.array(z.number().int()),
  ),
});

/**
 * Pure: weekly hours from the form. For each weekday d: `open_d` checkbox, `start_d`, `end_d`.
 * Returns [{ weekday, startMin, endMin }]; throws ValidationError naming the bad days.
 */
function parseHours(body) {
  const rows = [];
  const details = [];
  for (const [d, label] of WEEKDAYS) {
    if (!checkbox(body[`open_${d}`])) continue;
    const startMin = hhmmToMin(body[`start_${d}`]);
    const endMin = hhmmToMin(body[`end_${d}`]);
    if (startMin === null || endMin === null) {
      details.push({ path: `day_${d}`, message: `${label}: enter start and end times.` });
    } else if (endMin <= startMin) {
      details.push({ path: `day_${d}`, message: `${label}: the end must be after the start.` });
    } else if (endMin - startMin < 30) {
      details.push({ path: `day_${d}`, message: `${label}: a shift needs at least 30 minutes.` });
    } else {
      rows.push({ weekday: d, startMin, endMin });
    }
  }
  if (details.length) throw new ValidationError('Please check the highlighted days.', details);
  return rows;
}

/**
 * Pure: a time-off range from the form → { startsAt, endsAt } in UTC.
 * All-day ranges run from 00:00 on the first date to 24:00 on the last.
 */
function parseTimeOff(body) {
  const from = String(body.fromDate || '');
  const to = String(body.toDate || '') || from;
  const allDay = checkbox(body.allDay);
  const details = [];
  if (!isValidDateStr(from)) details.push({ path: 'fromDate', message: 'Choose a start date.' });
  if (!isValidDateStr(to)) details.push({ path: 'toDate', message: 'Choose an end date.' });
  let startMin = 0;
  let endMin = 1440;
  if (!allDay) {
    startMin = hhmmToMin(body.fromTime);
    endMin = hhmmToMin(body.toTime);
    if (startMin === null) details.push({ path: 'fromTime', message: 'Enter a start time.' });
    if (endMin === null) details.push({ path: 'toTime', message: 'Enter an end time.' });
  }
  if (details.length) throw new ValidationError('Please check the time off.', details);
  const startsAt = wallClockToUtc(from, startMin);
  const endsAt = endMin === 1440 ? wallClockToUtc(addDays(to, 1), 0) : wallClockToUtc(to, endMin);
  if (endsAt <= startsAt) {
    throw new ValidationError('The end must be after the start.', [
      { path: 'toDate', message: 'The end must be after the start.' },
    ]);
  }
  if (endsAt - startsAt > 366 * 86_400_000) {
    throw new ValidationError('Time off can’t be longer than a year.', [
      { path: 'toDate', message: 'Too long.' },
    ]);
  }
  const reason =
    String(body.reason || '')
      .trim()
      .slice(0, 120) || null;
  return { startsAt, endsAt, reason };
}

// ---------------------------------------------------------------------------
// Queries and writes
// ---------------------------------------------------------------------------

const listBarbers = ({ db = prisma } = {}) =>
  db.barber.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { hours: true, _count: { select: { services: true, bookings: true } } },
  });

async function getBarber(id, { now = new Date(), db = prisma } = {}) {
  return db.barber.findUnique({
    where: { id },
    include: {
      services: true,
      hours: { orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }] },
      timeOff: { where: { endsAt: { gt: now } }, orderBy: { startsAt: 'asc' } },
    },
  });
}

async function saveProfile(id, body, { file, db = prisma } = {}) {
  const data = catalog.parse(profileSchema, body);
  const current = id ? await db.barber.findUnique({ where: { id } }) : null;
  if (id && !current) throw new NotFoundError('Barber not found');
  let photoUrl = current ? current.photoUrl : null;
  if (file) photoUrl = await images.saveUpload(file.buffer, { kind: 'barbers', name: data.name });
  const fields = {
    name: data.name,
    slug: await catalog.uniqueSlug(db.barber, data.name, id),
    bio: data.bio,
    specialties: data.specialties,
    doesHomeService: data.doesHomeService,
    active: data.active,
    photoUrl,
  };
  const saved = await db.$transaction(async (tx) => {
    let row;
    if (id) {
      row = await tx.barber.update({ where: { id }, data: fields });
    } else {
      const last = await tx.barber.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      row = await tx.barber.create({
        data: { ...fields, sortOrder: (last ? last.sortOrder : 0) + 10 },
      });
    }
    await tx.barberService.deleteMany({ where: { barberId: row.id } });
    if (data.serviceIds.length) {
      await tx.barberService.createMany({
        data: data.serviceIds.map((serviceId) => ({ barberId: row.id, serviceId })),
        skipDuplicates: true,
      });
    }
    return row;
  });
  if (file && current && current.photoUrl !== photoUrl)
    await images.removeUpload(current.photoUrl, { kind: 'barbers' });
  return saved;
}

/** Upcoming active bookings that no longer fit inside the given weekly hours. */
async function bookingsOutsideHours(barberId, rows, { now = new Date(), db = prisma } = {}) {
  const upcoming = await db.booking.findMany({
    where: { barberId, status: { in: ACTIVE_STATUSES }, startsAt: { gte: now } },
    select: { id: true, reference: true, startsAt: true, endsAt: true },
  });
  return upcoming.filter((b) => {
    const date = toShopDate(b.startsAt);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const start = Math.round((b.startsAt - wallClockToUtc(date, 0)) / 60_000);
    const end = start + Math.round((b.endsAt - b.startsAt) / 60_000);
    return !rows.some((r) => r.weekday === weekday && r.startMin <= start && r.endMin >= end);
  });
}

async function saveHours(barberId, body, { now = new Date(), db = prisma } = {}) {
  const rows = parseHours(body);
  await db.$transaction([
    db.workingHours.deleteMany({ where: { barberId } }),
    db.workingHours.createMany({ data: rows.map((r) => ({ ...r, barberId })) }),
  ]);
  return { rows, outside: await bookingsOutsideHours(barberId, rows, { now, db }) };
}

/** Adds time off and returns the upcoming bookings it overlaps (they are not cancelled). */
async function addTimeOff(barberId, body, { db = prisma } = {}) {
  const range = parseTimeOff(body);
  const timeOff = await db.timeOff.create({ data: { ...range, barberId } });
  const clashes = await db.booking.findMany({
    where: {
      barberId,
      status: { in: ACTIVE_STATUSES },
      blockStartsAt: { lt: range.endsAt },
      blockEndsAt: { gt: range.startsAt },
    },
    select: { id: true, reference: true, startsAt: true },
    orderBy: { startsAt: 'asc' },
  });
  return { timeOff, clashes };
}

async function deleteTimeOff(barberId, id, { db = prisma } = {}) {
  const { count } = await db.timeOff.deleteMany({ where: { id, barberId } });
  if (!count) throw new NotFoundError('Time off not found');
}

/** A barber's upcoming pending/confirmed bookings (they stand even if the barber is deactivated). */
const upcomingBookings = (barberId, { now = new Date(), db = prisma } = {}) =>
  db.booking.findMany({
    where: { barberId, status: { in: ACTIVE_STATUSES }, startsAt: { gte: now } },
    select: { id: true, reference: true, startsAt: true },
    orderBy: { startsAt: 'asc' },
  });

/** Hours as form values: { [weekday]: { open, start, end } }. */
function hoursForForm(hours) {
  const out = {};
  for (const [d] of WEEKDAYS) {
    const h = hours.find((x) => x.weekday === d);
    out[d] = h
      ? { open: true, start: minutesToHHMM(h.startMin), end: minutesToHHMM(h.endMin) }
      : { open: false, start: '10:00', end: '20:00' };
  }
  return out;
}

module.exports = {
  WEEKDAYS,
  hhmmToMin,
  parseHours,
  parseTimeOff,
  profileSchema,
  listBarbers,
  getBarber,
  saveProfile,
  saveHours,
  bookingsOutsideHours,
  addTimeOff,
  deleteTimeOff,
  upcomingBookings,
  hoursForForm,
};
