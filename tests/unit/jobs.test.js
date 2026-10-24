const { remindersDue, lastTouched } = require('../../src/jobs/tasks');

const H = 3_600_000;
const start = new Date('2026-10-30T10:00:00Z');
const at = (hoursBefore) => new Date(start.getTime() - hoursBefore * H);
const booking = (o = {}) => ({
  startsAt: start,
  createdAt: at(72),
  confirmedAt: at(72),
  events: [],
  ...o,
});

describe('reminder windows', () => {
  test('nothing more than 24 h out', () => {
    expect(remindersDue(booking(), at(30))).toEqual([]);
  });

  test('24 h reminder from 24 h until 2 h before', () => {
    expect(remindersDue(booking(), at(24))).toEqual(['reminder-24h']);
    expect(remindersDue(booking(), at(3))).toEqual(['reminder-24h']);
    expect(remindersDue(booking(), at(2))).toEqual(['reminder-2h']); // 2h takes over
  });

  test('2 h reminder within 2 h, nothing once it has started', () => {
    expect(remindersDue(booking(), at(1))).toEqual(['reminder-2h']);
    expect(remindersDue(booking(), at(0))).toEqual([]);
    expect(remindersDue(booking(), at(-1))).toEqual([]);
  });

  test('no reminder for a window the customer was just messaged in', () => {
    // booked 20 h ahead: no 24 h reminder, but the 2 h one still comes
    const late = booking({ createdAt: at(20), confirmedAt: at(20) });
    expect(remindersDue(late, at(10))).toEqual([]);
    expect(remindersDue(late, at(1.5))).toEqual(['reminder-2h']);
    // moved 1 h before: the "rescheduled" message is enough
    const moved = booking({ events: [{ type: 'RESCHEDULED', createdAt: at(1) }] });
    expect(remindersDue(moved, at(0.5))).toEqual([]);
  });

  test('a home visit confirmed late counts as the latest message', () => {
    const b = booking({ createdAt: at(72), confirmedAt: at(5) });
    expect(lastTouched(b)).toEqual(at(5));
    expect(remindersDue(b, at(4))).toEqual([]);
  });
});
