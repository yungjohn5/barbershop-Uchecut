// Owner reports: bookings and revenue for a date range, compared with the period before.
// "Booked" revenue counts every booking that still stands (pending, confirmed, completed);
// "taken" counts completed visits only. Prices come from the BookingService snapshots.
const prisma = require('../lib/prisma');
const {
  wallClockToUtc,
  addDays,
  diffDays,
  toShopDate,
  weekdayOf,
  isValidDateStr,
} = require('../lib/time');

const STANDING = ['PENDING', 'CONFIRMED', 'COMPLETED'];
const PRESETS = {
  week: 'This week',
  lastweek: 'Last week',
  month: 'This month',
  lastmonth: 'Last month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

const monthStart = (date) => `${date.slice(0, 8)}01`;
const monthEnd = (date) => {
  const [y, m] = date.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
};
const weekStart = (date) => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * Pure: resolve a preset or custom range to inclusive shop dates.
 * Custom ranges are capped at 366 days and swapped if reversed.
 */
function resolveRange({ preset, from, to } = {}, today) {
  if (isValidDateStr(from) && isValidDateStr(to) && !preset) {
    let [a, b] = from <= to ? [from, to] : [to, from];
    if (diffDays(a, b) > 365) a = addDays(b, -365);
    return { preset: 'custom', from: a, to: b, label: 'Custom range' };
  }
  const p = PRESETS[preset] ? preset : 'month';
  let range;
  if (p === 'week') range = { from: weekStart(today), to: addDays(weekStart(today), 6) };
  else if (p === 'lastweek')
    range = { from: addDays(weekStart(today), -7), to: addDays(weekStart(today), -1) };
  else if (p === 'month') range = { from: monthStart(today), to: monthEnd(today) };
  else if (p === 'lastmonth') {
    const prev = addDays(monthStart(today), -1);
    range = { from: monthStart(prev), to: prev };
  } else if (p === '30d') range = { from: addDays(today, -29), to: today };
  else range = { from: addDays(today, -89), to: today };
  return { preset: p, ...range, label: PRESETS[p] };
}

/** Pure: the equal-length period just before a range. */
function previousRange({ from, to }) {
  const days = diffDays(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

const pct = (a, b) => (b ? a / b : null);
const change = (now, before) => (before ? (now - before) / before : null);

/** Pure: everything the report page shows, from a list of bookings. */
function summarise(bookings, { from, to }) {
  const standing = bookings.filter((b) => STANDING.includes(b.status));
  const completed = bookings.filter((b) => b.status === 'COMPLETED');
  const count = (s) => bookings.filter((b) => b.status === s).length;
  const sum = (list) => list.reduce((n, b) => n + b.totalKobo, 0);
  const noShows = count('NO_SHOW');

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    days.push({ date: d, bookedKobo: 0, takenKobo: 0, count: 0 });
  const dayIndex = Object.fromEntries(days.map((d, i) => [d.date, i]));
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((wd) => ({ weekday: wd, count: 0 }));
  const byBarber = new Map();
  const byService = new Map();
  const byZone = new Map();

  for (const b of standing) {
    const day = days[dayIndex[toShopDate(b.startsAt)]];
    if (day) {
      day.bookedKobo += b.totalKobo;
      day.count += 1;
      if (b.status === 'COMPLETED') day.takenKobo += b.totalKobo;
    }
    weekdays.find((w) => w.weekday === weekdayOf(toShopDate(b.startsAt))).count += 1;

    const br = byBarber.get(b.barberId) || {
      name: b.barber.name,
      count: 0,
      bookedKobo: 0,
      takenKobo: 0,
    };
    br.count += 1;
    br.bookedKobo += b.totalKobo;
    if (b.status === 'COMPLETED') br.takenKobo += b.totalKobo;
    byBarber.set(b.barberId, br);

    for (const s of b.services) {
      const sv = byService.get(s.serviceId) || { name: s.name, count: 0, revenueKobo: 0 };
      sv.count += 1;
      sv.revenueKobo += s.priceKobo;
      byService.set(s.serviceId, sv);
    }
    if (b.type === 'HOME') {
      const key = b.zoneId || 0;
      const z = byZone.get(key) || {
        name: b.zone ? b.zone.name : 'Unknown area',
        count: 0,
        feesKobo: 0,
      };
      z.count += 1;
      z.feesKobo += b.homeFeeKobo || 0;
      byZone.set(key, z);
    }
  }

  const desc = (k) => (a, b) => b[k] - a[k];
  return {
    total: bookings.length,
    status: {
      PENDING: count('PENDING'),
      CONFIRMED: count('CONFIRMED'),
      COMPLETED: completed.length,
      CANCELLED: count('CANCELLED'),
      NO_SHOW: noShows,
    },
    standing: standing.length,
    bookedKobo: sum(standing),
    takenKobo: sum(completed),
    // Rounded to whole naira: an average is an estimate, kobo would be false precision.
    avgTicketKobo: standing.length ? Math.round(sum(standing) / standing.length / 100) * 100 : 0,
    noShowRate: pct(noShows, completed.length + noShows),
    cancelRate: pct(count('CANCELLED'), bookings.length),
    homeShare: pct(standing.filter((b) => b.type === 'HOME').length, standing.length),
    staffShare: pct(standing.filter((b) => b.source === 'STAFF').length, standing.length),
    days,
    weekdays,
    byBarber: [...byBarber.values()].sort(desc('bookedKobo')),
    byService: [...byService.values()].sort(desc('revenueKobo')),
    byZone: [...byZone.values()].sort(desc('count')),
  };
}

async function loadBookings({ from, to }, db) {
  return db.booking.findMany({
    where: { startsAt: { gte: wallClockToUtc(from, 0), lt: wallClockToUtc(addDays(to, 1), 0) } },
    select: {
      id: true,
      status: true,
      type: true,
      source: true,
      startsAt: true,
      totalKobo: true,
      homeFeeKobo: true,
      barberId: true,
      zoneId: true,
      barber: { select: { name: true } },
      zone: { select: { name: true } },
      services: { select: { serviceId: true, name: true, priceKobo: true } },
    },
  });
}

async function buildReport(query, { now = new Date(), db = prisma } = {}) {
  const range = resolveRange(query, toShopDate(now));
  const prev = previousRange(range);
  const [current, before] = await Promise.all([loadBookings(range, db), loadBookings(prev, db)]);
  const report = summarise(current, range);
  const last = summarise(before, prev);
  return {
    range,
    prev,
    report,
    deltas: {
      bookedKobo: change(report.bookedKobo, last.bookedKobo),
      takenKobo: change(report.takenKobo, last.takenKobo),
      standing: change(report.standing, last.standing),
      avgTicketKobo: change(report.avgTicketKobo, last.avgTicketKobo),
    },
    presets: PRESETS,
  };
}

module.exports = { PRESETS, resolveRange, previousRange, summarise, buildReport };
