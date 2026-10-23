const path = require('path');
const ejs = require('ejs');
const { minutesLeft } = require('../../src/middleware/rateLimits');

describe('rate limit messages', () => {
  test('minutes until reset are rounded up, at least 1', () => {
    const at = (ms) => ({ rateLimit: { resetTime: new Date(Date.now() + ms) } });
    expect(minutesLeft(at(13.2 * 60_000))).toBe(14);
    expect(minutesLeft(at(5_000))).toBe(1);
    expect(minutesLeft(at(-5_000))).toBe(1);
    expect(minutesLeft({})).toBe(15);
  });

  test('the 429 page explains itself and offers WhatsApp', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../../src/views/pages/error.ejs'), {
      status: 429,
      message: 'Too many booking attempts.',
      shop: { whatsapp: '2348031234567' },
    });
    expect(html).toContain('Too many attempts.');
    expect(html).toContain('https://wa.me/2348031234567');
  });
});
