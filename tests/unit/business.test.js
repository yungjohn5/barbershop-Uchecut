const { resolveRange, previousRange, summarise } = require('../../src/services/reports');
const { searchPatterns, customerStats } = require('../../src/services/customers');
const { rowsFor } = require('../../src/services/settingsAdmin');
const { keepForm } = require('../../src/routes/admin/helpers');

const TODAY = '2026-10-22'; // a Thursday

describe('report ranges', () => {
  test('presets resolve to inclusive shop dates', () => {
    expect(resolveRange({ preset: 'week' }, TODAY)).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-25',
    });
    expect(resolveRange({ preset: 'lastweek' }, TODAY)).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(resolveRange({ preset: 'month' }, TODAY)).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(resolveRange({ preset: 'lastmonth' }, TODAY)).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(resolveRange({ preset: '30d' }, TODAY)).toMatchObject({
      from: '2026-09-23',
      to: '2026-10-22',
    });
    expect(resolveRange({ preset: 'nonsense' }, TODAY).preset).toBe('month');
  });

  test('December rolls into the next year', () => {
    expect(resolveRange({ preset: 'month' }, '2026-12-05')).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(resolveRange({ preset: 'lastmonth' }, '2027-01-10')).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });

  test('custom ranges are swapped if reversed and capped at a year', () => {
    expect(resolveRange({ from: '2026-10-10', to: '2026-10-01' }, TODAY)).toMatchObject({
      preset: 'custom',
      from: '2026-10-01',
      to: '2026-10-10',
    });
    expect(resolveRange({ from: '2020-01-01', to: '2026-10-01' }, TODAY).from).toBe('2025-10-01');
  });

  test('the previous period has the same length', () => {
    expect(previousRange({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
  });
});

describe('summarise', () => {
  const b = (o) => ({
    status: 'CONFIRMED',
    type: 'SHOP',
    source: 'WEB',
    totalKobo: 750000,
    homeFeeKobo: 0,
    barberId: 1,
    barber: { name: 'Tunde' },
    zoneId: null,
    zone: null,
    services: [{ serviceId: 1, name: 'Cut', priceKobo: 750000 }],
    startsAt: new Date('2026-10-05T10:00:00Z'),
    ...o,
  });
  const report = summarise(
    [
      b({ status: 'COMPLETED' }),
      b({
        status: 'COMPLETED',
        barberId: 2,
        barber: { name: 'Emeka' },
        totalKobo: 1200000,
        services: [{ serviceId: 2, name: 'Fade', priceKobo: 1200000 }],
      }),
      b({ status: 'NO_SHOW' }),
      b({ status: 'CANCELLED' }),
      b({
        type: 'HOME',
        source: 'STAFF',
        zoneId: 4,
        zone: { name: 'Lekki' },
        totalKobo: 1250000,
        homeFeeKobo: 500000,
        startsAt: new Date('2026-10-06T10:00:00Z'),
      }),
    ],
    { from: '2026-10-05', to: '2026-10-11' },
  );

  test('headline numbers count standing bookings and completed takings', () => {
    expect(report.standing).toBe(3);
    expect(report.bookedKobo).toBe(750000 + 1200000 + 1250000);
    expect(report.takenKobo).toBe(1950000);
    expect(report.avgTicketKobo).toBe(1066700); // ₦10,666.67 → ₦10,667
    expect(report.noShowRate).toBeCloseTo(1 / 3);
    expect(report.cancelRate).toBeCloseTo(1 / 5);
    expect(report.homeShare).toBeCloseTo(1 / 3);
    expect(report.staffShare).toBeCloseTo(1 / 3);
  });

  test('daily series covers every day, even empty ones', () => {
    expect(report.days).toHaveLength(7);
    expect(report.days[0]).toMatchObject({
      date: '2026-10-05',
      bookedKobo: 1950000,
      takenKobo: 1950000,
      count: 2,
    });
    expect(report.days[1]).toMatchObject({ date: '2026-10-06', bookedKobo: 1250000, takenKobo: 0 });
    expect(report.days[6].count).toBe(0);
  });

  test('breakdowns are sorted by money', () => {
    expect(report.byBarber.map((x) => x.name)).toEqual(['Tunde', 'Emeka']);
    expect(report.byService[0]).toEqual({ name: 'Cut', count: 2, revenueKobo: 1500000 });
    expect(report.byZone).toEqual([{ name: 'Lekki', count: 1, feesKobo: 500000 }]);
    expect(report.weekdays.find((w) => w.weekday === 1).count).toBe(2); // Monday 5 Oct
  });

  test('no bookings: no division by zero', () => {
    const empty = summarise([], { from: '2026-10-05', to: '2026-10-05' });
    expect(empty).toMatchObject({
      bookedKobo: 0,
      avgTicketKobo: 0,
      noShowRate: null,
      homeShare: null,
    });
  });
});

describe('customers', () => {
  test('search patterns match Nigerian numbers however they are typed', () => {
    expect(searchPatterns('0803 123')).toMatchObject({ phone: '%803123%' });
    expect(searchPatterns('+234 803')).toMatchObject({ phone: '%803%' });
    expect(searchPatterns('ada')).toEqual({ like: '%ada%', phone: null });
    expect(searchPatterns('50%_off').like).toBe('%50\\%\\_off%');
    expect(searchPatterns('   ')).toBeNull();
  });

  test('customerStats', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const mk = (status, iso, total = 500000, name = 'Cut') => ({
      status,
      startsAt: new Date(iso),
      totalKobo: total,
      services: [{ name }],
    });
    const s = customerStats(
      [
        mk('COMPLETED', '2026-10-01T10:00:00Z'),
        mk('COMPLETED', '2026-10-10T10:00:00Z', 900000, 'Fade'),
        mk('COMPLETED', '2026-09-01T10:00:00Z'),
        mk('NO_SHOW', '2026-10-15T10:00:00Z'),
        mk('CANCELLED', '2026-10-18T10:00:00Z'),
        mk('CONFIRMED', '2026-10-30T10:00:00Z'),
      ],
      now,
    );
    expect(s).toMatchObject({
      visits: 5,
      completed: 3,
      spentKobo: 1900000,
      noShows: 1,
      cancelled: 1,
      favourite: 'Cut',
    });
    expect(s.lastVisit.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    expect(s.nextVisit.startsAt.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });
});

describe('settings forms', () => {
  test('booking rules: hours in, minutes out', () => {
    const rows = rowsFor('booking', {
      leadTimeShopMin: '1.5',
      leadTimeHomeMin: '24',
      cancelCutoffMin: '0.25',
      homeAutoCancelHours: '12',
      bookingWindowDays: '45',
      slotStepMin: '30',
    });
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      leadTimeShopMin: 90,
      leadTimeHomeMin: 1440,
      cancelCutoffMin: 15,
      homeAutoCancelHours: 12,
      bookingWindowDays: 45,
      slotStepMin: 30,
      allowBufferOutsideShift: false,
    });
  });

  test('booking rules: odd values are refused', () => {
    const base = {
      leadTimeShopMin: '2',
      leadTimeHomeMin: '24',
      cancelCutoffMin: '3',
      homeAutoCancelHours: '12',
      bookingWindowDays: '30',
      slotStepMin: '15',
    };
    expect(() => rowsFor('booking', { ...base, leadTimeShopMin: '1.1' })).toThrow();
    expect(() => rowsFor('booking', { ...base, slotStepMin: '7' })).toThrow();
    expect(() => rowsFor('booking', { ...base, bookingWindowDays: '0' })).toThrow();
  });

  test('shop: lines, socials and phone clean-up', () => {
    const [row] = rowsFor('shop', {
      name: 'Victory',
      tagline: 'Sharp.',
      address: '12 Admiralty Way\r\n\r\nLekki, Lagos\n',
      phone: '+234 803 123 4567',
      whatsapp: '+234 803 123 4567',
      email: 'Hello@Victory.NG',
      hoursText: 'Mon–Sat · 10:00–20:00',
      instagram: 'https://instagram.com/victory',
      tiktok: '',
    });
    expect(row.key).toBe('shop');
    expect(row.value).toMatchObject({
      address: ['12 Admiralty Way', 'Lekki, Lagos'],
      phone: '+2348031234567',
      whatsapp: '2348031234567',
      email: 'hello@victory.ng',
      socials: { instagram: 'https://instagram.com/victory', tiktok: '', x: '', youtube: '' },
    });
    expect(() =>
      rowsFor('shop', {
        ...row.value,
        address: 'x',
        hoursText: 'x',
        instagram: 'javascript:alert(1)',
      }),
    ).toThrow();
  });

  test('shop: map pin pasted from Google Maps becomes lat/lng; blank clears it', () => {
    const shop = {
      name: 'Victory',
      tagline: 'Sharp.',
      address: 'Lekki',
      phone: '+2348031234567',
      whatsapp: '2348031234567',
      email: 'a@b.ng',
      hoursText: 'Mon',
    };
    expect(rowsFor('shop', { ...shop, mapPin: ' 6.4281 , 3.4219 ' })[0].value).toMatchObject({
      lat: 6.4281,
      lng: 3.4219,
    });
    expect(rowsFor('shop', { ...shop, mapPin: '' })[0].value).toMatchObject({
      lat: null,
      lng: null,
    });
    expect(() => rowsFor('shop', { ...shop, mapPin: 'Lekki Phase 1' })).toThrow();
    expect(() => rowsFor('shop', { ...shop, mapPin: '95, 3.4' })).toThrow();
  });

  test('home: the hero needs exactly three lines', () => {
    const copy = {
      heroText: 'a',
      introTitle: 'a',
      introText: 'a',
      servicesTitle: 'a',
      servicesText: 'a',
      craftTitle: 'a',
      craftText: 'a',
      craftNote: 'a',
      barbersTitle: 'a',
      homeTitle: 'a',
      homeText: 'a',
      productsTitle: 'a',
      productsText: 'a',
      footerText: 'a',
    };
    expect(() => rowsFor('home', { ...copy, heroLines: 'One\nTwo' })).toThrow(
      expect.objectContaining({
        details: [{ path: 'heroLines', message: 'Add at least 3 hero lines.' }],
      }),
    );
    expect(rowsFor('home', { ...copy, heroLines: 'One\nTwo\nThree' })[0].value.heroLines).toEqual([
      'One',
      'Two',
      'Three',
    ]);
  });
});

describe('form state', () => {
  test('password fields are never kept in the session', () => {
    const req = { session: {} };
    keepForm(
      req,
      'account',
      {
        _csrf: 't',
        current: 'old-secret-1',
        password: 'new-secret-12',
        confirm: 'new-secret-12',
        name: 'Ada',
      },
      { details: [{ path: 'password', message: 'Too short' }] },
    );
    expect(req.session.adminForms.account).toEqual({
      values: { name: 'Ada' },
      errors: { password: 'Too short' },
    });
  });
});
