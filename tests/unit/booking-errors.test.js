const {
  pgErrorCode,
  isExclusionViolation,
  isRetryableTxError,
} = require('../../src/services/booking');

// Shape observed from Prisma 6 when the Booking_no_overlap constraint fires on a model query.
const unknownRequestError = Object.assign(
  new Error(
    'Invalid `tx.booking.create()` invocation:\n\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { ' +
      'code: "23P01", message: "conflicting key value violates exclusion constraint \\"Booking_no_overlap\\"" }) })',
  ),
  { name: 'PrismaClientUnknownRequestError' },
);

describe('Postgres error classification', () => {
  test('reads SQLSTATE from meta.code when Prisma provides it', () => {
    const err = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '23P01' },
    });
    expect(pgErrorCode(err)).toBe('23P01');
    expect(isExclusionViolation(err)).toBe(true);
  });

  test('reads SQLSTATE from driver adapter meta', () => {
    const err = { meta: { driverAdapterError: { cause: { originalCode: '40001' } } } };
    expect(pgErrorCode(err)).toBe('40001');
    expect(isRetryableTxError(err)).toBe(true);
  });

  test('falls back to the message for UnknownRequestError without meta', () => {
    expect(pgErrorCode(unknownRequestError)).toBe('23P01');
    expect(isExclusionViolation(unknownRequestError)).toBe(true);
  });

  test('P2034 and deadlocks are retryable; other errors are not', () => {
    expect(isRetryableTxError({ code: 'P2034' })).toBe(true);
    expect(isRetryableTxError({ meta: { code: '40P01' } })).toBe(true);
    expect(isRetryableTxError(unknownRequestError)).toBe(false);
    expect(isExclusionViolation(new Error('boom'))).toBe(false);
    expect(pgErrorCode(undefined)).toBeUndefined();
  });
});
