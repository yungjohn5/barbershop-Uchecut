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
