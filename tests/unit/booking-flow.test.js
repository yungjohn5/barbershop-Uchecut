const flow = require('../../src/services/bookingFlow');
const { canModify } = require('../../src/services/booking');
const { buildIcs } = require('../../src/lib/ics');

describe('wizard step guards', () => {
  test('nextIncompleteStep walks type → services → time → details', () => {
    expect(flow.nextIncompleteStep({})).toBe('type');
    expect(flow.nextIncompleteStep({ type: 'HOME' })).toBe('type'); // needs a zone
    expect(flow.nextIncompleteStep({ type: 'HOME', zoneId: 1 })).toBe('services');
    expect(flow.nextIncompleteStep({ type: 'SHOP', serviceIds: [] })).toBe('services');
    expect(flow.nextIncompleteStep({ type: 'SHOP', serviceIds: [1] })).toBe('time');
    expect(flow.nextIncompleteStep({ type: 'SHOP', serviceIds: [1], startsAt: 'x' })).toBe(
      'details',
    );
  });

  test('stepStates marks done/current/upcoming and what is reachable', () => {
    const states = flow.stepStates('time', { type: 'SHOP', serviceIds: [1] });
    expect(states.map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(states.map((s) => s.reachable)).toEqual([true, true, true, false]);
  });
});

describe('applyPrefill (deep links)', () => {
  test('service and barber links prefill the draft', () => {
    expect(flow.applyPrefill({}, { type: 'shop', service: '3', barber: '2' })).toEqual({
      type: 'SHOP',
      serviceIds: [3],
      barberId: 2,
    });
  });

  test('switching visit type clears zone and chosen time', () => {
    const draft = {
      type: 'HOME',
      zoneId: 4,
      serviceIds: [1],
      startsAt: '2030-01-07T09:00:00.000Z',
    };
    expect(flow.applyPrefill(draft, { type: 'SHOP' })).toEqual({ type: 'SHOP', serviceIds: [1] });
  });

  test('junk query values are ignored', () => {
    expect(
      flow.applyPrefill({ type: 'SHOP' }, { type: 'boat', service: 'abc', barber: '-1' }),
    ).toEqual({ type: 'SHOP' });
  });
});

describe('dateStrip and groupSlots', () => {
  test('labels today/tomorrow and marks closed weekdays', () => {
    const days = flow.dateStrip({
      today: '2026-10-17',
      days: 2,
      openWeekdays: new Set([1, 2, 3, 4, 5, 6]),
    });
    expect(days).toEqual([
      { date: '2026-10-17', weekday: 'Today', day: 17, month: 'Oct', closed: false }, // Saturday
      { date: '2026-10-18', weekday: 'Tmrw', day: 18, month: 'Oct', closed: true }, // Sunday
      { date: '2026-10-19', weekday: 'Mon', day: 19, month: 'Oct', closed: false },
    ]);
  });

  test('firstOpenDate skips closed days', () => {
    expect(flow.firstOpenDate('2026-10-18', new Set([1, 2, 3, 4, 5]))).toBe('2026-10-19');
  });

  test('groups slots into morning / afternoon / evening, dropping empty groups', () => {
    const g = flow.groupSlots(
      ['10:00', '11:45', '12:00', '16:45', '17:00'].map((time) => ({ time })),
    );
    expect(g.map((x) => [x.label, x.slots.length])).toEqual([
      ['Morning', 2],
      ['Afternoon', 2],
      ['Evening', 1],
    ]);
    expect(flow.groupSlots([{ time: '18:00' }]).map((x) => x.label)).toEqual(['Evening']);
  });

  test('formats times in Lagos', () => {
    expect(flow.formatWhen('2026-10-19T09:15:00Z')).toBe('Mon 19 Oct · 10:15');
    expect(flow.formatDay('2026-10-19T09:15:00Z')).toBe('Monday 19 October');
  });
});

describe('canModify (manage link cutoff)', () => {
  const at = (iso) => new Date(iso);
  const booking = (status, startsAt = '2030-01-07T12:00:00Z') => ({
    status,
    startsAt: at(startsAt),
  });

  test('allowed until the cutoff, refused after', () => {
    expect(
      canModify(booking('CONFIRMED'), { now: at('2030-01-07T08:59:00Z'), cutoffMin: 180 }).allowed,
    ).toBe(true);
    const late = canModify(booking('CONFIRMED'), {
      now: at('2030-01-07T09:00:00Z'),
      cutoffMin: 180,
    });
    expect(late.allowed).toBe(false);
    expect(late.reason).toMatch(/3 hours before/);
  });

  test('pending home visits can be changed; finished ones cannot', () => {
    const now = at('2030-01-01T00:00:00Z');
    expect(canModify(booking('PENDING'), { now, cutoffMin: 180 }).allowed).toBe(true);
    expect(canModify(booking('CANCELLED'), { now, cutoffMin: 180 }).reason).toMatch(/cancelled/);
    expect(canModify(booking('COMPLETED'), { now, cutoffMin: 180 }).allowed).toBe(false);
  });
});

describe('buildIcs', () => {
  const base = {
    uid: 'VB-7K3QX@example.com',
    start: new Date('2030-01-07T09:00:00Z'),
    end: new Date('2030-01-07T09:45:00Z'),
    summary: 'Victory Barbershop: Classic Haircut, Beard Trim',
    description: 'Manage: https://example.com/manage/abc',
    location: '12 Admiralty Way; Lekki',
    now: new Date('2030-01-01T00:00:00Z'),
  };

  test('produces a valid event with UTC times, escaped text and CRLF lines', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    expect(ics).toContain('DTSTART:20300107T090000Z');
    expect(ics).toContain('DTEND:20300107T094500Z');
    expect(ics).toContain('SUMMARY:Victory Barbershop: Classic Haircut\\, Beard Trim');
    expect(ics).toContain('LOCATION:12 Admiralty Way\\; Lekki');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  test('folds long lines at 75 octets and marks cancellations', () => {
    const ics = buildIcs({ ...base, description: 'x'.repeat(200), cancelled: true });
    ics.split('\r\n').forEach((line) => expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75));
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
  });
});

describe('firstAvailableDate', () => {
  test('skips closed days and days without slots', async () => {
    const asked = [];
    const slotsFor = async (date) => {
      asked.push(date);
      return { slots: date === '2026-10-20' ? [{ time: '10:00' }] : [], error: null };
    };
    // 2026-10-18 is a Sunday (closed): not queried at all.
    const r = await flow.firstAvailableDate({
      today: '2026-10-17',
      window: 30,
      openWeekdays: new Set([1, 2, 3, 4, 5, 6]),
      slotsFor,
    });
    expect(r.date).toBe('2026-10-20');
    expect(r.result.slots).toHaveLength(1);
    expect(asked).toEqual(['2026-10-17', '2026-10-19', '2026-10-20']);
  });

  test('falls back to the first open date when nothing is free', async () => {
    const r = await flow.firstAvailableDate({
      today: '2026-10-18',
      window: 30,
      openWeekdays: new Set([1, 2, 3, 4, 5]),
      slotsFor: async () => ({ slots: [], error: null }),
      maxDays: 3,
    });
    expect(r.date).toBe('2026-10-19');
  });
});

describe('formatNgPhone', () => {
  const { formatNgPhone } = require('../../src/lib/phone');
  test('groups +234 numbers for display', () => {
    expect(formatNgPhone('+2348030000002')).toBe('+234 803 000 0002');
    expect(formatNgPhone('+447911123456')).toBe('+447911123456');
    expect(formatNgPhone(null)).toBe('');
  });
});
