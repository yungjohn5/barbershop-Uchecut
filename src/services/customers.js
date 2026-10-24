// Customer directory for staff: search, visit history, spend and no-shows, notes.
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { NotFoundError } = require('../lib/errors');
const { parse } = require('./catalog');

// Columns of the per-customer summary (see listCustomers).
const SORTS = {
  // Most recent activity: the last past visit, else the upcoming one.
  recent: Prisma.sql`COALESCE(last_at, next_at) DESC NULLS LAST, id DESC`,
  visits: Prisma.sql`visits DESC, last_at DESC NULLS LAST, id DESC`,
  spent: Prisma.sql`spent DESC, id DESC`,
  noshows: Prisma.sql`"noShowCount" DESC, last_at DESC NULLS LAST, id DESC`,
  name: Prisma.sql`lower(name) ASC, id ASC`,
  newest: Prisma.sql`"createdAt" DESC, id DESC`,
};

/** Pure: search text → { like, phone } patterns. "0803 123" matches +234803123… */
function searchPatterns(q) {
  const text = String(q || '')
    .trim()
    .slice(0, 80);
  if (!text) return null;
  let digits = text.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return {
    like: `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    phone: digits.length >= 3 ? `%${digits}%` : null,
  };
}

async function listCustomers(
  { q, sort = 'recent', page = 1, pageSize = 25 } = {},
  { db = prisma } = {},
) {
  const s = searchPatterns(q);
  const where = s
    ? Prisma.sql`WHERE (c.name ILIKE ${s.like} OR c.email ILIKE ${s.like}${s.phone ? Prisma.sql` OR c.phone LIKE ${s.phone}` : Prisma.empty})`
    : Prisma.empty;
  const orderBy = SORTS[sort] || SORTS.recent;
  const offset = (Math.max(1, page) - 1) * pageSize;
  // Summarise per customer first, then sort on the computed columns.
  const rows = await db.$queryRaw`
    SELECT * FROM (
    SELECT c.id, c.name, c.phone, c.email, c."noShowCount", c."createdAt",
           COUNT(b.id) FILTER (WHERE b.status <> 'CANCELLED')::int AS visits,
           COALESCE(SUM(b."totalKobo") FILTER (WHERE b.status = 'COMPLETED'), 0)::int AS spent,
           MAX(b."startsAt") FILTER (WHERE b.status <> 'CANCELLED' AND b."startsAt" <= now()) AS last_at,
           MIN(b."startsAt") FILTER (WHERE b.status IN ('PENDING', 'CONFIRMED') AND b."startsAt" > now()) AS next_at,
           COUNT(*) OVER ()::int AS total
    FROM "Customer" c
    LEFT JOIN "Booking" b ON b."customerId" = c.id
    ${where}
    GROUP BY c.id
    ) summary
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${offset}`;
  const total = rows.length ? rows[0].total : 0;
  return {
    rows: rows.map(({ total: _t, last_at: lastAt, next_at: nextAt, ...r }) => ({
      ...r,
      lastAt,
      nextAt,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Pure: headline numbers for one customer's bookings. */
function customerStats(bookings, now = new Date()) {
  const kept = bookings.filter((b) => b.status !== 'CANCELLED');
  const completed = bookings.filter((b) => b.status === 'COMPLETED');
  const noShows = bookings.filter((b) => b.status === 'NO_SHOW').length;
  const past = kept.filter((b) => b.startsAt <= now).sort((a, b) => b.startsAt - a.startsAt);
  const upcoming = kept
    .filter((b) => b.startsAt > now && ['PENDING', 'CONFIRMED'].includes(b.status))
    .sort((a, b) => a.startsAt - b.startsAt);
  const counts = {};
  for (const b of completed) for (const s of b.services) counts[s.name] = (counts[s.name] || 0) + 1;
  const favourite = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return {
    visits: kept.length,
    completed: completed.length,
    spentKobo: completed.reduce((n, b) => n + b.totalKobo, 0),
    noShows,
    cancelled: bookings.length - kept.length,
    lastVisit: past[0] ? past[0].startsAt : null,
    nextVisit: upcoming[0] || null,
    favourite: favourite ? favourite[0] : null,
  };
}

async function getCustomer(id, { now = new Date(), db = prisma } = {}) {
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      bookings: {
        orderBy: { startsAt: 'desc' },
        include: { services: true, barber: true, zone: true },
      },
    },
  });
  if (!customer) return null;
  return { customer, stats: customerStats(customer.bookings, now) };
}

const customerSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z
      .string({ error: 'Enter a name.' })
      .min(2, 'Enter a name.')
      .max(80, 'Keep it under 80 characters.'),
  ),
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null),
    z.string().email('Enter a valid email, or leave it blank.').max(120).nullable(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    z.string().max(1000, 'Keep notes under 1,000 characters.').nullable(),
  ),
});

async function updateCustomer(id, body, { db = prisma } = {}) {
  const data = parse(customerSchema, body);
  const exists = await db.customer.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError('Customer not found');
  return db.customer.update({ where: { id }, data });
}

module.exports = {
  SORTS,
  searchPatterns,
  listCustomers,
  customerStats,
  getCustomer,
  updateCustomer,
};
