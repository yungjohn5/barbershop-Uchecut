const { allowedActions, transitionFor, weekStartOf } = require('../../src/services/adminBookings');
const { passwordProblem, isLocked, normaliseEmail } = require('../../src/services/adminAuth');
const { safeNext } = require('../../src/middleware/admin');
const { formatTime, formatShort, formatDay, formatShortDate } = require('../../src/lib/viewHelpers');

const NOW = new Date('2026-10-22T12:00:00Z'); // 13:00 in Lagos
const at = (iso, status) => ({ startsAt: new Date(iso), status });

describe('allowedActions', () => {
  test('pending, in the future: confirm, reschedule, cancel', () => {
    expect(allowedActions(at('2026-10-23T09:00:00Z', 'PENDING'), NOW)).toEqual(['confirm', 'reschedule', 'cancel']);
  });

  test('confirmed, in the future: reschedule and cancel only', () => {
    expect(allowedActions(at('2026-10-23T09:00:00Z', 'CONFIRMED'), NOW)).toEqual(['reschedule', 'cancel']);
  });

  test('confirmed, started: complete, no-show, cancel (no reschedule)', () => {
    expect(allowedActions(at('2026-10-22T11:30:00Z', 'CONFIRMED'), NOW)).toEqual(['complete', 'noShow', 'cancel']);
  });

  test('completed or no-show can be undone within 7 days, not after', () => {
    expect(allowedActions(at('2026-10-20T09:00:00Z', 'COMPLETED'), NOW)).toEqual(['undo']);
    expect(allowedActions(at('2026-10-20T09:00:00Z', 'NO_SHOW'), NOW)).toEqual(['undo']);
    expect(allowedActions(at('2026-10-10T09:00:00Z', 'COMPLETED'), NOW)).toEqual([]);
  });

  test('cancelled bookings are final', () => {
    expect(allowedActions(at('2026-10-23T09:00:00Z', 'CANCELLED'), NOW)).toEqual([]);
  });
});

describe('transitionFor', () => {
  test('no-show bumps the customer count; undoing a no-show takes it back', () => {
    expect(transitionFor({ status: 'CONFIRMED' }, 'noShow', { now: NOW }).noShowDelta).toBe(1);
    expect(transitionFor({ status: 'NO_SHOW' }, 'undo', { now: NOW })).toEqual({
      data: { status: 'CONFIRMED' },
      noShowDelta: -1,
    });
    expect(transitionFor({ status: 'COMPLETED' }, 'undo', { now: NOW }).noShowDelta).toBe(0);
  });

  test('cancel stores a trimmed reason, or a default', () => {
    expect(transitionFor({}, 'cancel', { now: NOW, reason: '  ill  ' }).data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'ill',
      cancelledAt: NOW,
    });
    expect(transitionFor({}, 'cancel', { now: NOW }).data.cancelReason).toBe('Cancelled by staff');
  });

  test('confirm stamps confirmedAt', () => {
    expect(transitionFor({}, 'confirm', { now: NOW }).data).toEqual({ status: 'CONFIRMED', confirmedAt: NOW });
  });

  test('unknown actions are rejected', () => {
    expect(() => transitionFor({}, 'delete', { now: NOW })).toThrow('Unknown action.');
  });
});

describe('admin auth helpers', () => {
  test('password policy: 12+ characters with letters and a number', () => {
    expect(passwordProblem('short1')).toMatch(/12 characters/);
    expect(passwordProblem('onlyletterslong')).toMatch(/number/);
    expect(passwordProblem('123456789012')).toMatch(/letters/);
    expect(passwordProblem('barbershop2026')).toBeNull();
  });

  test('isLocked compares lockedUntil with now', () => {
    expect(isLocked({ lockedUntil: null }, NOW)).toBe(false);
    expect(isLocked({ lockedUntil: new Date(NOW.getTime() + 60_000) }, NOW)).toBe(true);
    expect(isLocked({ lockedUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });

  test('emails are trimmed and lower-cased', () => {
    expect(normaliseEmail('  Owner@Shop.NG ')).toBe('owner@shop.ng');
  });

  test('safeNext only allows admin paths on this site', () => {
    expect(safeNext('/admin/bookings?scope=today')).toBe('/admin/bookings?scope=today');
    expect(safeNext('https://evil.example')).toBe('/admin');
    expect(safeNext('//evil.example/admin')).toBe('/admin');
    expect(safeNext('/admin\\..\\x')).toBe('/admin');
    expect(safeNext(undefined)).toBe('/admin');
  });
});

describe('calendar and date helpers', () => {
  test('weeks start on Monday', () => {
    expect(weekStartOf('2026-10-22')).toBe('2026-10-19'); // Thursday
    expect(weekStartOf('2026-10-19')).toBe('2026-10-19'); // Monday
    expect(weekStartOf('2026-10-25')).toBe('2026-10-19'); // Sunday
  });

  test('admin view dates are shown in Lagos time', () => {
    const late = new Date('2026-10-22T23:30:00Z'); // 00:30 on the 23rd in Lagos
    expect(formatTime(late)).toBe('00:30');
    expect(formatShort(late)).toBe('Fri 23 Oct');
    expect(formatDay(late)).toBe('Friday 23 October');
    expect(formatShortDate('2026-10-19')).toBe('19 Oct');
  });
});
