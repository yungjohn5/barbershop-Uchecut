const { homeFacts } = require('../../src/services/content');
const { naira, duration, srcset, src, pad2 } = require('../../src/lib/viewHelpers');
const { resolveSettings } = require('../../src/services/settings');
const { DEFAULT_SETTINGS } = require('../../src/config/constants');

describe('homeFacts', () => {
  test('derives hero facts from live data', () => {
    const facts = homeFacts({
      services: [
        { priceKobo: 750000, homeAvailable: true },
        { priceKobo: 300000, homeAvailable: true },
        { priceKobo: 1800000, homeAvailable: false },
      ],
      zones: [{ name: 'Lekki' }, { name: 'Yaba' }],
      barbers: [{ doesHomeService: true }, { doesHomeService: false }],
    });
    expect(facts).toEqual({
      fromPriceKobo: 300000,
      serviceCount: 3,
      homeServiceCount: 2,
      zoneCount: 2,
      zoneNames: ['Lekki', 'Yaba'],
      homeBarberCount: 1,
    });
  });

  test('copes with an empty catalogue', () => {
    expect(homeFacts({ services: [], zones: [], barbers: [] })).toMatchObject({
      fromPriceKobo: null,
      serviceCount: 0,
      zoneCount: 0,
    });
  });
});

describe('view helpers', () => {
  test('naira formats kobo without float errors', () => {
    expect(naira(750000)).toBe('₦7,500');
    expect(naira(1800000)).toBe('₦18,000');
    expect(naira(150)).toBe('₦1.50');
    expect(naira(0)).toBe('₦0');
  });

  test('duration reads naturally', () => {
    expect(duration(45)).toBe('45 min');
    expect(duration(60)).toBe('1 h');
    expect(duration(90)).toBe('1 h 30 min');
  });

  test('responsive image sources follow the base-width.webp convention', () => {
    expect(srcset('/images/site/hero', [800, 1400])).toBe(
      '/images/site/hero-800.webp 800w, /images/site/hero-1400.webp 1400w',
    );
    expect(src('/images/site/hero', [800, 1400])).toBe('/images/site/hero-1400.webp');
    expect(pad2(3)).toBe('03');
  });
});

describe('home copy settings', () => {
  test('stored fields override defaults field by field', () => {
    const s = resolveSettings([{ key: 'home', value: { heroText: 'Custom intro' } }]);
    expect(s.home.heroText).toBe('Custom intro');
    expect(s.home.heroLines).toEqual(DEFAULT_SETTINGS.home.heroLines);
  });

  test('a malformed object setting is ignored', () => {
    expect(resolveSettings([{ key: 'home', value: ['nope'] }]).home).toEqual(DEFAULT_SETTINGS.home);
  });
});

describe('shopStatus', () => {
  const { shopStatus } = require('../../src/services/content');
  const { rich, plain } = require('../../src/lib/viewHelpers');
  // Mon–Fri 10:00–20:00, Sat 10:00–18:00 (Lagos), Sunday closed.
  const hours = [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 600, endMin: 1200 })),
    { weekday: 6, startMin: 600, endMin: 1080 },
  ];
  const at = (iso) => shopStatus({ now: new Date(iso), hours });

  test('open during a shift (Lagos time, UTC+1)', () => {
    expect(at('2026-10-12T12:00:00Z')).toEqual({ open: true, label: 'Open now · until 20:00' }); // Mon 13:00
    expect(at('2026-10-17T16:59:00Z')).toEqual({ open: true, label: 'Open now · until 18:00' }); // Sat 17:59
  });

  test('closed before opening, after closing, and on Sunday', () => {
    expect(at('2026-10-12T07:30:00Z').label).toBe('Closed · opens today 10:00'); // Mon 08:30
    expect(at('2026-10-12T19:00:00Z').label).toBe('Closed · opens tomorrow 10:00'); // Mon 20:00 sharp
    expect(at('2026-10-17T18:00:00Z').label).toBe('Closed · opens Mon 10:00'); // Sat 19:00
    expect(at('2026-10-18T12:00:00Z').label).toBe('Closed · opens tomorrow 10:00'); // Sun
  });

  test('no hours configured', () => {
    expect(shopStatus({ now: new Date(), hours: [] }).open).toBe(false);
  });

  test('rich() escapes HTML and turns *word* into an accent', () => {
    expect(rich('The *Ritual* <b>')).toBe('The <em class="accent">Ritual</em> &lt;b&gt;');
    expect(plain('The *Ritual*')).toBe('The Ritual');
  });
});

describe('hoursSummary', () => {
  const { hoursSummary } = require('../../src/services/content');
  const shift = (weekday, startMin, endMin) => ({ weekday, startMin, endMin });

  test('groups Mon–Fri and lists Saturday separately; Sunday closed', () => {
    const hours = [...[1, 2, 3, 4, 5].map((d) => shift(d, 600, 1200)), shift(6, 600, 1080)];
    expect(hoursSummary(hours)).toEqual({
      groups: [
        { days: 'Mon–Fri', time: '10:00–20:00' },
        { days: 'Sat', time: '10:00–18:00' },
      ],
      closed: ['Sun'],
      text: 'Mon–Fri 10:00–20:00 · Sat 10:00–18:00',
    });
  });

  test('union across barbers: earliest start, latest finish per day', () => {
    const hours = [
      shift(1, 600, 1080),
      shift(1, 660, 1200),
      ...[2, 3, 4, 5].map((d) => shift(d, 600, 1200)),
    ];
    expect(hoursSummary(hours).groups[0]).toEqual({ days: 'Mon–Fri', time: '10:00–20:00' });
  });

  test('every day the same reads "Daily"; a gap mid-week splits the run', () => {
    expect(hoursSummary([0, 1, 2, 3, 4, 5, 6].map((d) => shift(d, 540, 1260))).text).toBe(
      'Daily 09:00–21:00',
    );
    const gap = [1, 2, 4, 5].map((d) => shift(d, 600, 1200));
    expect(hoursSummary(gap).text).toBe('Mon–Tue 10:00–20:00 · Thu–Fri 10:00–20:00');
    expect(hoursSummary(gap).closed).toEqual(['Wed', 'Sat', 'Sun']);
  });

  test('no hours yet', () => {
    expect(hoursSummary([])).toEqual({
      groups: [],
      closed: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      text: 'Hours coming soon',
    });
  });
});
