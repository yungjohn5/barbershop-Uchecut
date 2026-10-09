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

  let retries = 0;
  let refCollisions = 0;
  for (;;) {
    try {
      return await attemptCreate(db, input, { now, settings, phone, hooks });
    } catch (err) {
      if (isExclusionViolation(err)) {
        logger.debug('createBooking: exclusion constraint rejected overlapping insert');
        throw new SlotTakenError();
      }
      // Regenerate the reference (31^5 space, so collisions are rare); no backoff needed.
      if (isReferenceCollision(err) && ++refCollisions < 5) continue;
      if (isRetryableTxError(err) && retries < MAX_SERIALIZATION_RETRIES) {
        retries += 1;
        logger.debug(
          `createBooking: serialization conflict (${err.code ?? pgErrorCode(err)}), retry ${retries}`,
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

module.exports = {
  createBooking,
  bookingInputSchema,
  pgErrorCode,
  isExclusionViolation,
  isRetryableTxError,
  MAX_SERIALIZATION_RETRIES,
};
