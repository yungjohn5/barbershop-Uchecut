// SMS is optional: without Termii keys it's off, customers are messaged by email only, live
// mode needs only SMTP, and SMS rows queued earlier are skipped rather than retried.
const loadEnv = (vars) => {
  let env;
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  jest.isolateModules(() => {
    env = require('../../src/config/env');
  });
  process.env = saved;
  return env;
};

describe('switch', () => {
  const none = { TERMII_API_KEY: '', TERMII_SENDER_ID: '', SMS_ENABLED: '' };

  test('off without Termii keys, on with both, and SMS_ENABLED overrides', () => {
    expect(loadEnv(none).smsEnabled).toBe(false);
    expect(loadEnv({ ...none, TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'Victory' }).smsEnabled).toBe(
      true,
    );
    expect(
      loadEnv({ TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'Victory', SMS_ENABLED: 'false' })
        .smsEnabled,
    ).toBe(false);
  });

  test('live mode needs SMTP only while SMS is off, Termii too when it is on', () => {
    const smtp = { SMTP_HOST: 'smtp.gmail.com', MAIL_FROM: 'Shop <shop@example.org>' };
    expect(() => loadEnv({ ...none, ...smtp, NOTIFY_MODE: 'live' })).not.toThrow();
    expect(() => loadEnv({ ...none, ...smtp, NOTIFY_MODE: 'live', SMS_ENABLED: 'true' })).toThrow(
      /TERMII_API_KEY/,
    );
    expect(() => loadEnv({ ...none, SMTP_HOST: '', NOTIFY_MODE: 'live' })).toThrow(/SMTP_HOST/);
  });
});

describe('messages while SMS is off', () => {
  const env = require('../../src/config/env');
  const notifications = require('../../src/services/notifications');
  let was;
  beforeEach(() => {
    was = env.smsEnabled;
    env.smsEnabled = false;
  });
  afterEach(() => {
    env.smsEnabled = was;
  });

  const booking = (email) => ({
    id: 1,
    reference: 'VB-ABCDE',
    customer: { phone: '+2348030000001', email },
  });

  test('customers get email only (and nothing without an email)', () => {
    const rows = notifications.customerRows(booking('kunle@example.com'), 'shop-confirmed', {}, '');
    expect(rows.map((r) => r.channel)).toEqual(['EMAIL']);
    expect(notifications.customerRows(booking(null), 'shop-confirmed', {}, '')).toEqual([]);
    // the 2-hour reminder is SMS-only, so it's not queued at all
    expect(notifications.customerRows(booking('k@example.com'), 'reminder-2h', {}, ':x')).toEqual(
      [],
    );
  });

  test('an SMS queued before the switch is skipped, never sent or retried', async () => {
    const updates = [];
    const db = { notification: { update: async (q) => updates.push(q) && q } };
    await notifications.deliver(
      {
        id: 9,
        attempts: 0,
        channel: 'SMS',
        template: 'shop-confirmed',
        to: '+2348030000001',
        payload: {
          shopName: 'Victory',
          reference: 'VB-ABCDE',
          when: 'Mon 3 Nov, 10:00',
          manageUrl: 'http://x/manage/t',
        },
      },
      { mode: 'live', db },
    );
    expect(updates[0].data).toMatchObject({
      status: 'SKIPPED',
      lastError: expect.stringMatching(/SMS is off/),
    });
  });
});
