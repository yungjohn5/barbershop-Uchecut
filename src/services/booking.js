// Booking creation. Runs the full availability check again inside a Serializable
// transaction, so the slot the customer saw is re-validated against the latest data.
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const logger = require('../lib/logger');
const { normaliseNgPhone } = require('../lib/phone');
const { generateReference, generateManageToken } = require('../lib/ids');
const { HttpError, SlotTakenError, ValidationError } = require('../lib/errors');
const { toShopDate, wallClockToUtc, addDays } = require('../lib/time');
const { ACTIVE_STATUSES } = require('../config/constants');
const settingsService = require('./settings');
const { computeDay, pickLeastBusy } = require('./availability');

const MAX_SERIALIZATION_RETRIES = 3;
const BOOKING_LOCK_NAMESPACE = 7341; // first key of pg_advisory_xact_lock(ns, barberId)
const MIN = 60_000;

const bookingInputSchema = z
  .object({
    type: z.enum(['SHOP', 'HOME']),
    serviceIds: z.array(z.number().int().positive()).min(1).max(10),
    zoneId: z.number().int().positive().nullish(),
    barberId: z.union([z.literal('any'), z.number().int().positive()]).default('any'),
    startsAt: z.coerce.date(),
    customer: z.object({
      name: z.string().trim().min(2).max(80),
      phone: z.string().trim().min(7).max(25),
      email: z.string().trim().toLowerCase().email().max(120).optional().or(z.literal('')),
    }),
    address: z.string().trim().max(300).optional(),
    landmark: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'HOME' && (!v.address || v.address.length < 5)) {
      ctx.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'Address is required for home visits.',
      });
    }
    if (v.type === 'HOME' && v.zoneId == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['zoneId'],
        message: 'Choose a zone for a home visit.',
      });
    }
  });

// ---------------------------------------------------------------------------
// Postgres error classification
// ---------------------------------------------------------------------------

/**
 * SQLSTATE from a Prisma error. Prisma 6 exposes it in `meta.code` for raw queries /
 * driver adapters, but a constraint violation from a model query arrives as a
 * PrismaClientUnknownRequestError whose only trace is the message
 * (`PostgresError { code: "23P01", ... }`), so fall back to parsing that.
 */
function pgErrorCode(err) {
  if (!err) return undefined;
  const metaCode = err.meta?.code ?? err.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof metaCode === 'string' && /^[0-9A-Z]{5}$/.test(metaCode)) return metaCode;
  const match = /PostgresError\s*\{\s*code:\s*"([0-9A-Z]{5})"/.exec(err.message || '');
  return match ? match[1] : undefined;
}

const isExclusionViolation = (err) => pgErrorCode(err) === '23P01';
const isRetryableTxError = (err) =>
  err?.code === 'P2034' || ['40001', '40P01'].includes(pgErrorCode(err));
const isReferenceCollision = (err) =>
  err?.code === 'P2002' && [].concat(err.meta?.target ?? []).includes('reference');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with full jitter: 0..(50·2^attempt) ms, plus a 10 ms floor.
const backoffMs = (attempt) => 10 + Math.floor(Math.random() * 50 * 2 ** attempt);

// ---------------------------------------------------------------------------

async function attemptCreate(db, input, { now, settings, phone, hooks }) {
  return db.$transaction(
    async (tx) => {
      const date = toShopDate(input.startsAt);
      const { slots, selection } = await computeDay(
        tx,
        {
          date,
          barberId: input.barberId,
          serviceIds: input.serviceIds,
          type: input.type,
          zoneId: input.zoneId ?? null,
        },
        { now, settings },
      );

      const slot = slots.find((s) => s.startsAt === input.startsAt.toISOString());
      if (!slot) throw new SlotTakenError();

      let barberId = input.barberId;
      if (barberId === 'any') {
        const dayStart = wallClockToUtc(date, 0);
        const dayEnd = wallClockToUtc(addDays(date, 1), 0);
        const counts = await tx.booking.groupBy({
          by: ['barberId'],
          where: {
            barberId: { in: slot.barberIds },
            status: { in: ACTIVE_STATUSES },
            startsAt: { gte: dayStart, lt: dayEnd },
          },
          _count: { _all: true },
        });
        barberId = pickLeastBusy(
          slot.barberIds,
          Object.fromEntries(counts.map((c) => [c.barberId, c._count._all])),
        );
      } else if (!slot.barberIds.includes(barberId)) {
        throw new SlotTakenError();
      }

      const startsAt = input.startsAt;
      const endsAt = new Date(startsAt.getTime() + selection.serviceMin * MIN);
      const blockStartsAt = new Date(startsAt.getTime() - selection.bufferMin * MIN);
      const blockEndsAt = new Date(endsAt.getTime() + selection.bufferMin * MIN);

      // Explicit overlap re-check for the chosen barber before insert.
      const clash = await tx.booking.findFirst({
        where: {
          barberId,
          status: { in: ACTIVE_STATUSES },
          blockStartsAt: { lt: blockEndsAt },
          blockEndsAt: { gt: blockStartsAt },
        },
        select: { id: true },
      });
      if (clash) throw new SlotTakenError();

      // Test seam: lets the concurrency test hold every attempt here so they all insert at once.
      if (hooks.beforeInsert) await hooks.beforeInsert();

      // Queue inserts per barber. Without this, simultaneous conflicting inserts wait on each
      // other inside the exclusion constraint's GiST index and deadlock (40P01). With it, the
      // next attempt meets the committed row: 23P01 → SlotTakenError, or 40001 → retry → re-check.
      // Released automatically at commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}::int, ${barberId}::int)`;

      const customer = await tx.customer.upsert({
        where: { phone },
        update: {
          name: input.customer.name,
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        create: { name: input.customer.name, phone, email: input.customer.email || null },
      });

      const isHome = input.type === 'HOME';
      return tx.booking.create({
        data: {
          reference: generateReference(),
          manageToken: generateManageToken(),
          type: input.type,
          status: isHome ? 'PENDING' : 'CONFIRMED',
          confirmedAt: isHome ? null : now,
          startsAt,
          endsAt,
          blockStartsAt,
          blockEndsAt,
          address: isHome ? input.address : null,
          landmark: isHome ? input.landmark || null : null,
          notes: input.notes || null,
          subtotalKobo: selection.subtotalKobo,
          homeFeeKobo: selection.homeFeeKobo,
          totalKobo: selection.totalKobo,
          barberId,
          customerId: customer.id,
          zoneId: isHome ? selection.zone.id : null,
          services: {
            create: selection.services.map((s) => ({
              serviceId: s.id,
              name: s.name,
              priceKobo: s.priceKobo,
              durationMin: s.durationMin,
            })),
          },
        },
        include: { services: true, barber: true, customer: true, zone: true },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    },
  );
}

/**
 * Create a booking. SHOP → CONFIRMED, HOME → PENDING.
 * Throws ValidationError (400), SlotTakenError (409) or HttpError 503 under heavy contention.
 */
async function createBooking(rawInput, { now = new Date(), db = prisma, hooks = {} } = {}) {
  const parsed = bookingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(
      'Please check your booking details.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const input = parsed.data;
  const phone = normaliseNgPhone(input.customer.phone);
  if (!phone) {
    throw new ValidationError('Enter a valid Nigerian mobile number.', [
      { path: 'customer.phone', message: 'Invalid phone number' },
    ]);
  }
  const settings = await settingsService.getAll();
  return withTxRetry('createBooking', () =>
    attemptCreate(db, input, { now, settings, phone, hooks }),
  );
}

/**
 * Runs a booking write with the shared failure policy:
 * 23P01 → SlotTakenError; reference collision → retry; P2034/40001/40P01 → up to
 * MAX_SERIALIZATION_RETRIES retries with jittered backoff, then 503.
 */
async function withTxRetry(label, attempt) {
  let retries = 0;
  let refCollisions = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (isExclusionViolation(err)) {
        logger.debug(`${label}: exclusion constraint rejected overlapping insert`);
        throw new SlotTakenError();
      }
      // Regenerate the reference (31^5 space, so collisions are rare); no backoff needed.
      if (isReferenceCollision(err) && ++refCollisions < 5) continue;
      if (isRetryableTxError(err) && retries < MAX_SERIALIZATION_RETRIES) {
        retries += 1;
        logger.debug(
          `${label}: serialization conflict (${err.code ?? pgErrorCode(err)}), retry ${retries}`,
        );
        await sleep(backoffMs(retries));
        continue;
      }
      if (isRetryableTxError(err)) {
        throw new HttpError(503, 'We are busy right now. Please try again in a moment.', {
          code: 'BOOKING_BUSY',
        });
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Manage link: look up, cancel, reschedule
// ---------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const bookingInclude = {
  services: { orderBy: { serviceId: 'asc' } },
  barber: true,
  customer: true,
  zone: true,
};

/**
 * Pure: may the customer still cancel or reschedule this booking themselves?
 * Returns { allowed, reason } where reason explains a refusal for the UI.
 */
function canModify(booking, { now, cutoffMin }) {
  if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
    const why = {
      CANCELLED: 'This booking has been cancelled.',
      COMPLETED: 'This booking has already taken place.',
      NO_SHOW: 'This booking has already passed.',
    };
    return {
      allowed: false,
      reason: why[booking.status] || 'This booking can no longer be changed.',
    };
  }
  const deadline = booking.startsAt.getTime() - cutoffMin * MIN;
  if (now.getTime() >= deadline) {
    const hours = cutoffMin % 60 === 0 ? `${cutoffMin / 60} hours` : `${cutoffMin} minutes`;
    return {
      allowed: false,
      reason: `Changes close ${hours} before your appointment. Please call or WhatsApp us instead.`,
    };
  }
  return { allowed: true, reason: null };
}

async function getBookingByToken(token, { db = prisma } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return db.booking.findUnique({ where: { manageToken: token }, include: bookingInclude });
}

async function requireModifiable(db, token, now) {
  const booking = await getBookingByToken(token, { db });
  if (!booking) throw new HttpError(404, 'We couldn’t find that booking.', { code: 'NOT_FOUND' });
  const settings = await settingsService.getAll();
  const check = canModify(booking, { now, cutoffMin: settings.cancelCutoffMin });
  if (!check.allowed) throw new HttpError(409, check.reason, { code: 'LOCKED' });
  return { booking, settings };
}

/** Cancel via the manage link (before the cutoff). Frees the slot immediately. */
async function cancelBooking(token, { now = new Date(), reason, db = prisma } = {}) {
  await requireModifiable(db, token, now);
  return db.booking.update({
    where: { manageToken: token },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: reason ? String(reason).trim().slice(0, 300) || null : 'Cancelled by customer',
    },
    include: bookingInclude,
  });
}

/**
 * Move a booking to a new slot via the manage link. Same services, type and zone; prices
 * stay as booked. Runs the full availability check (ignoring the booking's own block) in a
 * Serializable transaction with the per-barber lock. Home visits go back to PENDING so
 * staff re-confirm the new time.
 */
async function rescheduleBooking(
  token,
  { startsAt, barberId = 'any' },
  { now = new Date(), db = prisma } = {},
) {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new ValidationError('Choose a new time.');
  const { booking, settings } = await requireModifiable(db, token, now);
  const wanted = barberId === 'any' ? 'any' : Number(barberId);

  return withTxRetry('rescheduleBooking', () =>
    db.$transaction(
      async (tx) => {
        const date = toShopDate(start);
        const { slots, selection } = await computeDay(
          tx,
          {
            date,
            barberId: wanted,
            serviceIds: booking.services.map((s) => s.serviceId),
            type: booking.type,
            zoneId: booking.zoneId,
            excludeBookingId: booking.id,
          },
          { now, settings },
        );
        const slot = slots.find((s) => s.startsAt === start.toISOString());
        if (!slot) throw new SlotTakenError();
        // Prefer keeping the same barber when "any" and they are free.
        const nextBarber =
          wanted === 'any'
            ? slot.barberIds.includes(booking.barberId)
              ? booking.barberId
              : slot.barberIds[0]
            : wanted;
        if (!slot.barberIds.includes(nextBarber)) throw new SlotTakenError();

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}::int, ${nextBarber}::int)`;
        const endsAt = new Date(start.getTime() + selection.serviceMin * MIN);
        const isHome = booking.type === 'HOME';
        return tx.booking.update({
          where: { id: booking.id },
          data: {
            startsAt: start,
            endsAt,
            blockStartsAt: new Date(start.getTime() - selection.bufferMin * MIN),
            blockEndsAt: new Date(endsAt.getTime() + selection.bufferMin * MIN),
            barberId: nextBarber,
            status: isHome ? 'PENDING' : 'CONFIRMED',
            confirmedAt: isHome ? null : (booking.confirmedAt ?? now),
          },
          include: bookingInclude,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    ),
  );
}

module.exports = {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getBookingByToken,
  canModify,
  bookingInputSchema,
  pgErrorCode,
  isExclusionViolation,
  isRetryableTxError,
  MAX_SERIALIZATION_RETRIES,
};
