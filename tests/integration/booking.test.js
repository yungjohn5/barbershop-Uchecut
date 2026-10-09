const { prisma, resetDb, seedFixtures } = require('./fixtures');
const { createBooking, isExclusionViolation, pgErrorCode } = require('../../src/services/booking');
const { getSlots } = require('../../src/services/availability');
const { SlotTakenError, ValidationError } = require('../../src/lib/errors');
const { wallClockToUtc } = require('../../src/lib/time');

const DATE = '2030-01-07'; // a Monday
const NOW = new Date('2030-01-01T08:00:00Z');
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return wallClockToUtc(DATE, h * 60 + m);
};

let fx;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});
afterAll(() => prisma.$disconnect());

const customer = (n = 1) => ({ name: `Customer ${n}`, phone: `0803000000${n % 10}` });
const shopInput = (o = {}) => ({
  type: 'SHOP',
  serviceIds: [fx.cut.id],
  barberId: fx.shopBarber.id,
  startsAt: at('10:00').toISOString(),
  customer: customer(1),
  ...o,
});
const homeInput = (o = {}) => ({
  type: 'HOME',
  serviceIds: [fx.cut.id],
  zoneId: fx.zone.id,
  barberId: 'any',
  startsAt: at('12:00').toISOString(),
  address: '12 Admiralty Way, Lekki Phase 1',
  landmark: 'Opposite the filling station',
  customer: customer(2),
  ...o,
});

// Raw booking row for bypassing the service layer.
async function rawBooking({ barberId, from, to, status = 'CONFIRMED', ref }) {
  const c = await prisma.customer.upsert({
    where: { phone: '+2348099999999' },
    update: {},
    create: { name: 'Raw', phone: '+2348099999999' },
  });
  return prisma.booking.create({
    data: {
      reference: ref,
      manageToken: `token-${ref}`,
      type: 'SHOP',
      status,
      startsAt: from,
      endsAt: to,
      blockStartsAt: from,
      blockEndsAt: to,
      subtotalKobo: 0,
      totalKobo: 0,
      barberId,
      customerId: c.id,
    },
  });
}

describe('createBooking', () => {
  test('SHOP booking is CONFIRMED with snapshot, totals and normalised phone', async () => {
    const b = await createBooking(shopInput(), { now: NOW });
    expect(b.status).toBe('CONFIRMED');
    expect(b.confirmedAt).not.toBeNull();
    expect(b.reference).toMatch(/^VB-[A-Z2-9]{5}$/);
    expect(b.manageToken).toHaveLength(43);
    expect(b.startsAt.toISOString()).toBe(at('10:00').toISOString());
    expect(b.endsAt.toISOString()).toBe(at('10:30').toISOString());
    expect(b.blockStartsAt).toEqual(b.startsAt);
    expect(b.blockEndsAt).toEqual(b.endsAt);
    expect(b).toMatchObject({
      subtotalKobo: 750000,
      homeFeeKobo: 0,
      totalKobo: 750000,
      zoneId: null,
    });
    expect(b.customer.phone).toBe('+2348030000001');
    expect(b.services).toEqual([
      expect.objectContaining({
        serviceId: fx.cut.id,
        name: 'Cut',
        priceKobo: 750000,
        durationMin: 30,
      }),
    ]);
  });

  test('HOME booking is PENDING, blocks travel buffers and adds the zone fee', async () => {
    const b = await createBooking(homeInput(), { now: NOW });
    expect(b.status).toBe('PENDING');
    expect(b.barberId).toBe(fx.homeBarber.id); // only home-service barber is eligible
    expect(b.blockStartsAt.toISOString()).toBe(at('11:30').toISOString());
    expect(b.blockEndsAt.toISOString()).toBe(at('13:00').toISOString());
    expect(b).toMatchObject({ subtotalKobo: 750000, homeFeeKobo: 300000, totalKobo: 1050000 });
    expect(b.address).toContain('Admiralty');
  });

  test('HOME rejects a shop-only service', async () => {
    await expect(
      createBooking(homeInput({ serviceIds: [fx.cut.id, fx.shave.id] }), { now: NOW }),
    ).rejects.toMatchObject({ status: 400, code: 'HOME_NOT_AVAILABLE' });
  });

  test('"any barber" assigns the least-busy eligible barber that day', async () => {
    await createBooking(
      shopInput({ barberId: fx.shopBarber.id, startsAt: at('10:00').toISOString() }),
      { now: NOW },
    );
    await createBooking(
      shopInput({ barberId: fx.shopBarber.id, startsAt: at('11:00').toISOString() }),
      { now: NOW },
    );
    await createBooking(
      shopInput({ barberId: fx.homeBarber.id, startsAt: at('10:00').toISOString() }),
      { now: NOW },
    );
    const b = await createBooking(
      shopInput({ barberId: 'any', startsAt: at('15:00').toISOString() }),
      { now: NOW },
    );
    expect(b.barberId).toBe(fx.homeBarber.id); // 1 booking vs 2
  });

  test('a taken slot, an off-grid time and a slot inside lead time are rejected', async () => {
    await createBooking(shopInput(), { now: NOW });
    await expect(
      createBooking(shopInput({ customer: customer(3) }), { now: NOW }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    await expect(
      createBooking(shopInput({ startsAt: at('10:07').toISOString() }), { now: NOW }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    const lateNow = new Date(at('09:30').getTime());
    await expect(
      createBooking(shopInput({ startsAt: at('11:00').toISOString() }), { now: lateNow }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  test('time off blocks booking', async () => {
    await prisma.timeOff.create({
      data: { barberId: fx.shopBarber.id, startsAt: at('09:00'), endsAt: at('13:00') },
    });
    await expect(createBooking(shopInput(), { now: NOW })).rejects.toBeInstanceOf(SlotTakenError);
  });

  test('invalid input is a ValidationError', async () => {
    await expect(
      createBooking(shopInput({ customer: { name: 'A', phone: '123' } }), { now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createBooking(homeInput({ address: '' }), { now: NOW })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('getSlots hides a booked slot (and its buffers) afterwards', async () => {
    await createBooking(homeInput(), { now: NOW });
    const { slots } = await getSlots(
      { date: DATE, barberId: 'any', serviceIds: [fx.cut.id], type: 'HOME', zoneId: fx.zone.id },
      { now: NOW },
    );
    const t = slots.map((s) => s.time);
    expect(t).toContain('10:30'); // block 10:00–11:30
    expect(t).not.toContain('11:00');
    expect(t).not.toContain('13:15');
    expect(t).toContain('13:30'); // block 13:00–14:30
  });
});

// Holds the first `n` arrivals until all have arrived (or a timeout), then lets everyone through.
function barrier(n, timeoutMs = 5000) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
    setTimeout(resolve, timeoutMs).unref();
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

describe('double-booking protection', () => {
  // Open pool connections up front so attempts genuinely overlap.
  beforeEach(() =>
    Promise.all(Array.from({ length: 8 }, () => prisma.$executeRaw`SELECT pg_sleep(0.05)`)),
  );

  test('all attempts pass the availability check, then insert at once: the database lets exactly one win', async () => {
    const logger = require('../../src/lib/logger');
    const debug = jest.spyOn(logger, 'debug');
    const N = 4;
    const hooks = { beforeInsert: barrier(N) };
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        createBooking(shopInput({ customer: customer(i + 1) }), { now: NOW, hooks }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(SlotTakenError);
    }
    expect(await prisma.booking.count()).toBe(1);
    // The database layer (exclusion constraint or serializable conflict) must have done the work.
    const dbPath = debug.mock.calls.filter(([m]) =>
      /exclusion constraint|serialization conflict/.test(m),
    );
    expect(dbPath.length).toBeGreaterThanOrEqual(N - 1);
    debug.mockRestore();
  });

  test('concurrent attempts on the same slot: exactly one succeeds', async () => {
    const attempts = Array.from({ length: 6 }, (_, i) =>
      createBooking(shopInput({ customer: customer(i + 1) }), { now: NOW }),
    );
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    for (const f of failed) expect(f.reason).toBeInstanceOf(SlotTakenError);
    expect(await prisma.booking.count({ where: { barberId: fx.shopBarber.id } })).toBe(1);
  });

  test('concurrent overlapping (not identical) HOME requests: exactly one succeeds', async () => {
    const results = await Promise.allSettled(
      ['12:00', '12:15', '12:30', '12:45'].map((t, i) =>
        createBooking(homeInput({ startsAt: at(t).toISOString(), customer: customer(i + 1) }), {
          now: NOW,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('exclusion constraint rejects an overlapping insert that bypasses the service', async () => {
    await rawBooking({
      barberId: fx.shopBarber.id,
      from: at('10:00'),
      to: at('11:00'),
      ref: 'RAW-1',
    });
    let error;
    try {
      await rawBooking({
        barberId: fx.shopBarber.id,
        from: at('10:30'),
        to: at('11:30'),
        ref: 'RAW-2',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(pgErrorCode(error)).toBe('23P01');
    expect(isExclusionViolation(error)).toBe(true);
    expect(error.message).toContain('Booking_no_overlap');
  });

  test('exclusion constraint allows back-to-back, other barbers, and inactive statuses', async () => {
    await rawBooking({
      barberId: fx.shopBarber.id,
      from: at('10:00'),
      to: at('11:00'),
      ref: 'RAW-A',
    });
    await expect(
      rawBooking({ barberId: fx.shopBarber.id, from: at('11:00'), to: at('12:00'), ref: 'RAW-B' }),
    ).resolves.toBeDefined();
    await expect(
      rawBooking({ barberId: fx.homeBarber.id, from: at('10:00'), to: at('11:00'), ref: 'RAW-C' }),
    ).resolves.toBeDefined();
    await expect(
      rawBooking({
        barberId: fx.shopBarber.id,
        from: at('10:00'),
        to: at('11:00'),
        status: 'CANCELLED',
        ref: 'RAW-D',
      }),
    ).resolves.toBeDefined();
  });
});
