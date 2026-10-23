const { TEMPLATES, render, htmlToText } = require('../../src/services/notifyTemplates');
const { maskRecipient, maskTokens, payloadFor } = require('../../src/services/notifications');

// A realistic booking on a realistic domain: the manage token is 43 characters.
const booking = {
  id: 7,
  reference: 'VB-K7M2P',
  type: 'HOME',
  startsAt: new Date('2026-10-27T10:00:00Z'), // 11:00 in Lagos
  endsAt: new Date('2026-10-27T10:45:00Z'),
  manageToken: 'a'.repeat(43),
  totalKobo: 1250000,
  homeFeeKobo: 500000,
  address: '7 Admiralty Way, Lekki',
  landmark: 'Opposite the bank',
  zoneId: 1,
  barber: { name: 'Tunde A.' },
  services: [{ serviceId: 2, name: 'Classic Haircut' }],
  customer: { name: 'Kemi Adeyemi', phone: '+2348031234567', email: 'kemi@example.com' },
  zone: { name: 'Lekki' },
};
const shop = {
  name: 'Victory Barbershop',
  phone: '+2348000000000',
  whatsapp: '2348000000000',
  email: 'hello@victory.ng',
  address: ['12 Admiralty Way', 'Lagos'],
};
const payload = payloadFor(booking, {
  shop,
  appUrl: 'https://victorybarbershop.ng',
  extra: { by: 'customer', reason: null, needsConfirm: true, fromWhen: 'Mon 26 Oct, 14:00' },
});

describe('payload', () => {
  test('times are in Lagos and links are absolute', () => {
    expect(payload).toMatchObject({
      when: 'Tue 27 Oct, 11:00',
      time: '11:00',
      endTime: '11:45',
      day: 'Tuesday 27 October',
      customerFirst: 'Kemi',
      manageUrl: `https://victorybarbershop.ng/manage/${'a'.repeat(43)}`,
      rebookUrl: 'https://victorybarbershop.ng/book?type=HOME&service=2&zone=1',
    });
  });
});

describe('templates', () => {
  const customer = Object.keys(TEMPLATES).filter((t) => !TEMPLATES[t].owner);

  test.each(customer)(
    '%s SMS has the reference and manage link and fits one segment',
    async (t) => {
      const { text } = await render(t, 'SMS', payload);
      expect(text).toContain('VB-K7M2P');
      expect(text).toContain(payload.manageUrl);
      expect(text.length).toBeLessThanOrEqual(160);
    },
  );

  test.each(Object.keys(TEMPLATES))('%s email renders with subject, HTML and text', async (t) => {
    const msg = await render(t, 'EMAIL', payload);
    expect(msg.subject).toContain('VB-K7M2P');
    expect(msg.html).toContain('<!doctype html>');
    expect(msg.html).toContain('Victory Barbershop');
    expect(msg.text).toContain('VB-K7M2P');
    if (!TEMPLATES[t].owner) expect(msg.html).toContain(payload.manageUrl);
    else expect(msg.html).toContain(payload.adminUrl);
    expect(msg.text).not.toMatch(/<[a-z]/i);
  });

  test('home visit emails show the address and landmark', async () => {
    const { text } = await render('home-confirmed', 'EMAIL', payload);
    expect(text).toContain('7 Admiralty Way, Lekki');
    expect(text).toContain('Landmark: Opposite the bank');
    expect(text).toContain('₦12,500');
  });

  test('owner templates have no SMS; unknown templates throw', async () => {
    await expect(render('owner-new-booking', 'SMS', payload)).rejects.toThrow(/no SMS/);
    await expect(render('nope', 'EMAIL', payload)).rejects.toThrow(/Unknown/);
  });

  test('htmlToText keeps link targets and line breaks', () => {
    expect(htmlToText('<p>Hi <b>Kemi</b></p><p><a href="https://x.ng/m">Manage</a></p>')).toBe(
      'Hi Kemi\nManage (https://x.ng/m)',
    );
  });
});

describe('log privacy', () => {
  test('recipients and manage tokens are masked', () => {
    expect(maskRecipient('+2348031234567')).toBe('+234***567');
    expect(maskRecipient('kemi@example.com')).toBe('k***@example.com');
    expect(maskTokens(`see https://x.ng/manage/${'a'.repeat(43)} now`)).toBe(
      'see https://x.ng/manage/… now',
    );
  });
});
