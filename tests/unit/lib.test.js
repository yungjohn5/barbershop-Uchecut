const { normaliseNgPhone } = require('../../src/lib/phone');
const { generateReference, generateManageToken, REF_ALPHABET } = require('../../src/lib/ids');
const {
  isValidDateStr,
  addDays,
  diffDays,
  weekdayOf,
  wallClockToUtc,
} = require('../../src/lib/time');
const { resolveSettings } = require('../../src/services/settings');
const { DEFAULT_SETTINGS } = require('../../src/config/constants');

describe('normaliseNgPhone', () => {
  test.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['803-123-4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['+234 (0) 803 123 4567', '+2348031234567'],
    ['07012345678', '+2347012345678'],
    ['09151234567', '+2349151234567'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseNgPhone(input)).toBe(expected);
  });

  test.each([
    '',
    '12345',
    '0803123456',
    '080312345678',
    '+447911123456',
    '06031234567',
    'abc',
    null,
  ])('rejects %p', (input) => {
    expect(normaliseNgPhone(input)).toBeNull();
  });
});

describe('ids', () => {
  test('reference format VB-XXXXX without look-alike characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const ref = generateReference();
      expect(ref).toMatch(/^VB-[A-Z2-9]{5}$/);
      for (const ch of ref.slice(3)) expect(REF_ALPHABET).toContain(ch);
    }
    expect(REF_ALPHABET).not.toMatch(/[01OIL]/);
  });

  test('manage token is 32 random bytes, base64url', () => {
    const t = generateManageToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(generateManageToken()).not.toBe(t);
  });
});

describe('time helpers', () => {
  test('date validation', () => {
    expect(isValidDateStr('2026-10-12')).toBe(true);
    expect(isValidDateStr('2026-02-30')).toBe(false);
    expect(isValidDateStr('2026-1-1')).toBe(false);
  });

  test('calendar arithmetic across month/year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-09-12', '2026-10-12')).toBe(30);
    expect(weekdayOf('2026-10-12')).toBe(1);
  });

  test('wall-clock minutes past midnight roll into the next day', () => {
    expect(wallClockToUtc('2026-10-12', 1440 + 60).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });
});

describe('resolveSettings', () => {
  test('falls back to defaults for missing or malformed values', () => {
    const s = resolveSettings([
      { key: 'leadTimeShopMin', value: 60 },
      { key: 'leadTimeHomeMin', value: -5 },
      { key: 'bookingWindowDays', value: '30' },
      { key: 'allowBufferOutsideShift', value: 'yes' },
      { key: 'shop', value: { name: 'Uche Cuts' } },
    ]);
    expect(s.leadTimeShopMin).toBe(60);
    expect(s.leadTimeHomeMin).toBe(DEFAULT_SETTINGS.leadTimeHomeMin);
    expect(s.bookingWindowDays).toBe(DEFAULT_SETTINGS.bookingWindowDays);
    expect(s.allowBufferOutsideShift).toBe(false);
    expect(s.shop.name).toBe('Uche Cuts');
    expect(s.shop.hoursText).toEqual(DEFAULT_SETTINGS.shop.hoursText);
  });
});
