const { Writable } = require('stream');
const pino = require('pino');
const { weakSecret, productionProblems } = require('../../src/config/env');
const logger = require('../../src/lib/logger');
const { detectImageType } = require('../../src/lib/fileType');

describe('production startup checks', () => {
  const strong = 'f3a9c1e7b2d84a6f9e0c5b1d7a3e8f2c6b9d0a4e1f7c3b8a5d2e9f6c0b4a7d1e';
  const ok = {
    SESSION_SECRET: strong,
    ADMIN_PASSWORD: '',
    APP_URL: 'https://victorybarbershop.ng',
    CLOUDINARY_URL: 'cloudinary://key:secret@victory',
    CLOUDINARY_FOLDER: 'victory/prod',
  };

  test('a strong setup passes', () => {
    expect(weakSecret(strong)).toBe(false);
    expect(productionProblems(ok)).toEqual([]);
  });

  test.each([
    ['the .env.example value', 'change-me-to-a-long-random-string'],
    ['too short', 'abc123'],
    ['contains "secret"', 'my-super-secret-session-key-for-the-shop-2026'],
    ['too few distinct characters', 'abababababababababababababababababab'],
  ])('weak SESSION_SECRET: %s', (_label, value) => {
    expect(weakSecret(value)).toBe(true);
    expect(productionProblems({ ...ok, SESSION_SECRET: value })[0]).toMatch(/SESSION_SECRET/);
  });

  test('seed ADMIN_PASSWORD, plain-http APP_URL and missing/dev Cloudinary are refused', () => {
    const has = (overrides, re) =>
      productionProblems({ ...ok, ...overrides }).some((p) => re.test(p));
    expect(has({ ADMIN_PASSWORD: 'change-me-please' }, /ADMIN_PASSWORD/)).toBe(true);
    expect(has({ APP_URL: 'http://victorybarbershop.ng' }, /https/)).toBe(true);
    expect(has({ CLOUDINARY_URL: '' }, /CLOUDINARY_URL is required/)).toBe(true);
    expect(has({ CLOUDINARY_FOLDER: 'victory/dev' }, /CLOUDINARY_FOLDER/)).toBe(true);
  });

  test('DEMO_MODE (recordings only) is refused in production', () => {
    const has = (overrides) =>
      productionProblems({ ...ok, ...overrides }).some((p) => /DEMO_MODE/.test(p));
    expect(has({ DEMO_MODE: '1' })).toBe(true);
    expect(has({ DEMO_MODE: '' })).toBe(false);
  });

  test('the example MAIL_FROM is refused when messages go out for real', () => {
    const example = 'Victory Barbershop <bookings@example.com>';
    const has = (overrides) =>
      productionProblems({ ...ok, ...overrides }).some((p) => /MAIL_FROM/.test(p));
    expect(has({ MAIL_FROM: example, NOTIFY_MODE: 'live' })).toBe(true);
    expect(has({ MAIL_FROM: example, NOTIFY_MODE: 'log' })).toBe(false);
    expect(has({ MAIL_FROM: 'Victory <bookings@victorybarbershop.ng>' })).toBe(false);
  });
});

describe('logs without PII', () => {
  test('URLs: manage tokens shortened, phone and search values hidden', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG';
    expect(logger.safeUrl(`/manage/${token}/reschedule?date=2026-10-30`)).toBe(
      '/manage/abcdef…/reschedule?date=2026-10-30',
    );
    expect(logger.safeUrl('/admin/api/customer?phone=08031234567')).toBe(
      '/admin/api/customer?phone=…',
    );
    expect(logger.safeUrl('/admin/customers?q=0803&sort=name')).toBe(
      '/admin/customers?q=…&sort=name',
    );
  });

  test('phone, email and address fields are redacted at any depth', () => {
    const lines = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(chunk));
        cb();
      },
    });
    const log = pino({ ...logger.options, level: 'info' }, sink);
    log.info(
      { phone: '+2348031234567', customer: { email: 'k@x.ng', address: '1 Road' }, job: 'x' },
      'hello',
    );
    expect(lines[0]).toMatchObject({
      phone: '[redacted]',
      customer: { email: '[redacted]', address: '[redacted]' },
      job: 'x',
      msg: 'hello',
    });
  });
});

describe('upload type detection (magic bytes)', () => {
  const bytes = (...b) => Buffer.from(b);
  test.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
    ['webp', Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBPVP8 ')])],
  ])('accepts %s', (type, buf) => {
    expect(detectImageType(buf).type).toBe(type);
  });

  test.each([
    ['GIF', Buffer.from('GIF89a......')],
    ['SVG (script risk)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['a shell script named .jpg', Buffer.from('#!/bin/sh\necho hi')],
    ['an EXE', Buffer.from('MZ\x90\x00........')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_label, buf) => {
    expect(detectImageType(buf)).toBeNull();
  });
});
