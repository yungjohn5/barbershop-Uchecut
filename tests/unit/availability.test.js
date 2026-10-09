const {
  computeSlots,
  eligibleBarbers,
  summariseSelection,
  pickLeastBusy,
} = require('../../src/services/availability');
const { wallClockToUtc } = require('../../src/lib/time');
const { DEFAULT_SETTINGS } = require('../../src/config/constants');

const MONDAY = '2026-10-12';
const SUNDAY = '2026-10-11';
const FAR_PAST_NOW = new Date('2026-10-01T08:00:00Z'); // lead time irrelevant, inside 30-day window

const hhmm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
// Lagos wall-clock "HH:MM" on `date` → Date (UTC).
const at = (time, date = MONDAY) => wallClockToUtc(date, hhmm(time));
const block = (from, to, date = MONDAY) => ({ start: at(from, date), end: at(to, date) });
const times = (slots) => slots.map((s) => s.time);

const MON_FRI = { startMin: hhmm('10:00'), endMin: hhmm('20:00') };
const settings = { ...DEFAULT_SETTINGS };

function run(overrides = {}) {
  return computeSlots({
    date: MONDAY,
    now: FAR_PAST_NOW,
    type: 'SHOP',
    serviceMin: 45,
    bufferMin: 0,
    barbers: [{ id: 1, shifts: [MON_FRI], blocks: [] }],
    settings,
    ...overrides,
  });
}

describe('time conversion', () => {
  test('Lagos 10:00 is 09:00 UTC (WAT, UTC+1)', () => {
    expect(at('10:00').toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });
});

describe('shift edges', () => {
  test('first slot at shift start, last slot ends exactly at shift end', () => {
    const slots = run();
    expect(slots[0].time).toBe('10:00');
    expect(slots.at(-1).time).toBe('19:15'); // 19:15 + 45 min = 20:00
    expect(times(slots)).not.toContain('19:30');
    expect(slots).toHaveLength(38); // 10:00 … 19:15 every 15 min
  });

  test('slots are on the 15-minute grid with ISO UTC start and barber ids', () => {
    const [first, second] = run();
    expect(first).toEqual({ time: '10:00', startsAt: '2026-10-12T09:00:00.000Z', barberIds: [1] });
    expect(second.time).toBe('10:15');
  });

  test('service longer than the shift yields no slots', () => {
    expect(run({ serviceMin: 11 * 60 })).toEqual([]);
  });

  test('no shift on that weekday (Sunday closed) → no slots', () => {
    expect(run({ date: SUNDAY, barbers: [{ id: 1, shifts: [], blocks: [] }] })).toEqual([]);
  });

  test('split shifts are handled independently', () => {
    const shifts = [
      { startMin: hhmm('10:00'), endMin: hhmm('12:00') },
      { startMin: hhmm('14:00'), endMin: hhmm('16:00') },
    ];
    const t = times(run({ serviceMin: 60, barbers: [{ id: 1, shifts, blocks: [] }] }));
    expect(t).toEqual([
      '10:00',
      '10:15',
      '10:30',
      '10:45',
      '11:00',
      '14:00',
      '14:15',
      '14:30',
      '14:45',
      '15:00',
    ]);
  });

  test('honours a custom slot step', () => {
    const t = times(run({ settings: { ...settings, slotStepMin: 30 } }));
    expect(t.slice(0, 3)).toEqual(['10:00', '10:30', '11:00']);
    expect(t.at(-1)).toBe('19:00');
  });
});

describe('travel buffers (HOME)', () => {
  const home = (o = {}) =>
    run({
      type: 'HOME',
      serviceMin: 65,
      bufferMin: 45,
      now: new Date('2026-10-01T08:00:00Z'),
      ...o,
    });

  test('buffer before and after must fit inside the shift', () => {
    const t = times(home());
    expect(t[0]).toBe('10:45'); // 10:00 + 45 buffer
    expect(t.at(-1)).toBe('18:00'); // 18:00 + 65 + 45 = 19:50 ≤ 20:00; 18:15 would end 20:05
    expect(t).not.toContain('10:30');
    expect(t).not.toContain('18:15');
  });

  test('allowBufferOutsideShift lets only the service fit the shift', () => {
    const t = times(home({ settings: { ...settings, allowBufferOutsideShift: true } }));
    expect(t[0]).toBe('10:00');
    expect(t.at(-1)).toBe('18:45'); // 18:45 + 65 = 19:50; 19:00 + 65 = 20:05
  });

  test('buffers count against neighbouring bookings', () => {
    // Existing booking block 12:00–13:00; new visit 30 min + 30 buffer each side.
    const t = times(
      home({
        serviceMin: 30,
        bufferMin: 30,
        barbers: [{ id: 1, shifts: [MON_FRI], blocks: [block('12:00', '13:00')] }],
      }),
    );
    expect(t).toContain('11:00'); // block 10:30–12:00, touches but does not overlap
    expect(t).not.toContain('11:15');
    expect(t).not.toContain('13:15');
    expect(t).toContain('13:30'); // block 13:00–14:30
  });
});

describe('overlaps with existing bookings', () => {
  const busy = [block('12:00', '13:00')];
  const t = () => times(run({ barbers: [{ id: 1, shifts: [MON_FRI], blocks: busy }] }));

  test('back-to-back before and after is allowed (half-open ranges)', () => {
    expect(t()).toContain('11:15'); // 11:15–12:00
    expect(t()).toContain('13:00');
  });

  test('any overlap is rejected', () => {
    for (const bad of ['11:30', '11:45', '12:00', '12:30', '12:45']) expect(t()).not.toContain(bad);
  });

  test('a booking block spilling in from outside the shift still blocks', () => {
    const early = [block('09:00', '10:30')];
    const slots = times(run({ barbers: [{ id: 1, shifts: [MON_FRI], blocks: early }] }));
    expect(slots[0]).toBe('10:30');
  });
});

describe('time off', () => {
  test('full-day time off removes every slot', () => {
    const off = { start: at('00:00'), end: at('23:59') };
    expect(run({ barbers: [{ id: 1, shifts: [MON_FRI], blocks: [off] }] })).toEqual([]);
  });

  test('partial time off removes overlapping slots only', () => {
    const t = times(
      run({ barbers: [{ id: 1, shifts: [MON_FRI], blocks: [block('14:00', '16:00')] }] }),
    );
    expect(t).toContain('13:15');
    expect(t).not.toContain('13:30');
    expect(t).not.toContain('15:45');
    expect(t).toContain('16:00');
  });

  test('multi-day time off starting the day before still applies', () => {
    const off = { start: at('18:00', '2026-10-11'), end: at('12:00') };
    const t = times(run({ barbers: [{ id: 1, shifts: [MON_FRI], blocks: [off] }] }));
    expect(t[0]).toBe('12:00');
  });
});

describe('lead time and booking window', () => {
  test('SHOP: slots earlier than now + 2h are dropped', () => {
    const now = at('11:05'); // earliest start 13:05 → first grid slot 13:15
    expect(run({ now })[0].time).toBe('13:15');
  });

  test('SHOP: exactly now + lead time is allowed', () => {
    expect(run({ now: at('11:00') })[0].time).toBe('13:00');
  });

  test('HOME: 24h lead time empties today and trims tomorrow', () => {
    const now = at('11:05');
    const base = { type: 'HOME', serviceMin: 30, bufferMin: 30, now };
    expect(run(base)).toEqual([]);
    const tomorrow = run({ ...base, date: '2026-10-13' });
    expect(tomorrow[0].time).toBe('11:15');
  });

  test('lead time is configurable', () => {
    const now = at('11:05');
    const t = run({ now, settings: { ...settings, leadTimeShopMin: 0 } });
    expect(t[0].time).toBe('11:15');
  });

  test('dates in the past return nothing', () => {
    expect(run({ now: new Date('2026-10-13T08:00:00Z') })).toEqual([]);
  });

  test('30-day window: day 30 is bookable, day 31 is not', () => {
    const now = at('08:00', '2026-09-12'); // Monday 2026-10-12 is 30 days later
    expect(run({ now }).length).toBeGreaterThan(0);
    expect(run({ now: at('08:00', '2026-09-11') })).toEqual([]);
    expect(
      run({ now: at('08:00', '2026-09-11'), settings: { ...settings, bookingWindowDays: 31 } })
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('"any barber"', () => {
  test('merges slots across barbers and lists who is free', () => {
    const slots = run({
      barbers: [
        { id: 1, shifts: [MON_FRI], blocks: [block('10:00', '12:00')] },
        { id: 2, shifts: [{ startMin: hhmm('12:00'), endMin: hhmm('20:00') }], blocks: [] },
      ],
    });
    const byTime = Object.fromEntries(slots.map((s) => [s.time, s.barberIds]));
    expect(byTime['10:00']).toBeUndefined(); // 1 busy, 2 not on shift yet
    expect(byTime['12:00']).toEqual([1, 2]);
    expect(byTime['19:15']).toEqual([1, 2]);
    expect(slots.map((s) => s.startsAt)).toEqual([...slots.map((s) => s.startsAt)].sort());
  });

  test('pickLeastBusy chooses the barber with fewest bookings, ties → lowest id', () => {
    expect(pickLeastBusy([1, 2, 3], { 1: 4, 2: 1, 3: 2 })).toBe(2);
    expect(pickLeastBusy([3, 2], { 2: 1, 3: 1 })).toBe(2);
    expect(pickLeastBusy([5, 4], {})).toBe(4);
  });

  test('eligibleBarbers keeps barbers offering every service', () => {
    const barbers = [
      { id: 1, active: true, doesHomeService: true, serviceIds: [1, 2] },
      { id: 2, active: true, doesHomeService: false, serviceIds: [1, 2, 3] },
      { id: 3, active: false, doesHomeService: true, serviceIds: [1, 2, 3] },
    ];
    expect(eligibleBarbers(barbers, [1, 2], 'SHOP').map((b) => b.id)).toEqual([1, 2]);
    expect(eligibleBarbers(barbers, [3], 'SHOP').map((b) => b.id)).toEqual([2]);
    expect(eligibleBarbers(barbers, [1], 'HOME').map((b) => b.id)).toEqual([1]);
  });
});

describe('selection rules and pricing', () => {
  const cut = { id: 1, name: 'Cut', priceKobo: 750000, durationMin: 45, homeAvailable: true };
  const beard = { id: 2, name: 'Beard', priceKobo: 400000, durationMin: 20, homeAvailable: true };
  const shave = {
    id: 3,
    name: 'Hot Towel Shave',
    priceKobo: 600000,
    durationMin: 30,
    homeAvailable: false,
  };
  const zone = { id: 1, feeKobo: 500000, travelBufferMin: 45 };

  test('HOME rejects services that are not home-available', () => {
    expect(() => summariseSelection({ type: 'HOME', services: [cut, shave], zone })).toThrow(
      expect.objectContaining({ status: 400, code: 'HOME_NOT_AVAILABLE' }),
    );
  });

  test('the same services are fine in the shop', () => {
    expect(summariseSelection({ type: 'SHOP', services: [cut, shave], zone: null })).toMatchObject({
      serviceMin: 75,
      bufferMin: 0,
      subtotalKobo: 1350000,
      homeFeeKobo: 0,
      totalKobo: 1350000,
    });
  });

  test('HOME sums durations, applies zone buffer and fee', () => {
    expect(summariseSelection({ type: 'HOME', services: [cut, beard], zone })).toEqual({
      serviceMin: 65,
      bufferMin: 45,
      subtotalKobo: 1150000,
      homeFeeKobo: 500000,
      totalKobo: 1650000,
    });
  });

  test('HOME requires a zone; at least one service is required', () => {
    expect(() => summariseSelection({ type: 'HOME', services: [cut], zone: null })).toThrow(
      /zone/i,
    );
    expect(() => summariseSelection({ type: 'SHOP', services: [], zone: null })).toThrow(
      /service/i,
    );
  });
});
