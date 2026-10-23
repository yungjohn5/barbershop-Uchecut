// Message templates for the outbox. Each template has an email subject (body in
// views/emails/<template>.ejs) and, for customer messages, an SMS text that fits one 160-char
// segment where possible. Every customer message carries the reference and the manage link;
// times are Africa/Lagos (formatted when the payload is built).
const path = require('path');
const ejs = require('ejs');
const helpers = require('../lib/viewHelpers');

const VIEWS = path.join(__dirname, '..', 'views', 'emails');

const TEMPLATES = {
  // ---- customer
  'shop-confirmed': {
    subject: (p) => `You're booked: ${p.when} · ${p.reference}`,
    sms: (p) => `${p.shopName}: booked ${p.when}. Ref ${p.reference}. Manage: ${p.manageUrl}`,
  },
  'home-received': {
    subject: (p) => `Home visit request received · ${p.reference}`,
    sms: (p) =>
      `${p.shopName}: home visit ${p.when} requested; we'll call. ${p.reference} ${p.manageUrl}`,
  },
  'home-confirmed': {
    subject: (p) => `Home visit confirmed: ${p.when} · ${p.reference}`,
    sms: (p) => `${p.shopName}: home visit confirmed, ${p.when}. Ref ${p.reference} ${p.manageUrl}`,
  },
  'reminder-24h': {
    subject: (p) => `See you tomorrow at ${p.time} · ${p.reference}`,
    sms: (p) =>
      `${p.shopName}: reminder, ${p.when}. Ref ${p.reference}. Change/cancel: ${p.manageUrl}`,
  },
  'reminder-2h': {
    subject: (p) => `See you at ${p.time} · ${p.reference}`,
    sms: (p) =>
      `${p.shopName}: see you at ${p.time} today. Ref ${p.reference}. Manage: ${p.manageUrl}`,
  },
  rescheduled: {
    subject: (p) => `Booking moved to ${p.when} · ${p.reference}`,
    sms: (p) =>
      p.needsConfirm
        ? `${p.shopName}: moved to ${p.when}; we'll confirm. ${p.reference} ${p.manageUrl}`
        : `${p.shopName}: moved to ${p.when}. Ref ${p.reference}. Manage: ${p.manageUrl}`,
  },
  cancelled: {
    subject: (p) => `Booking cancelled · ${p.reference}`,
    sms: (p) => `${p.shopName}: ${p.when} booking ${p.reference} cancelled. ${p.manageUrl}`,
  },
  'auto-cancelled': {
    subject: (p) => `We couldn't confirm your home visit · ${p.reference}`,
    sms: (p) =>
      `${p.shopName}: home visit ${p.reference} not confirmed in time. Rebook: ${p.manageUrl}`,
  },
  // ---- owner
  'owner-new-booking': {
    owner: true,
    subject: (p) => `New booking: ${p.customerName}, ${p.when} · ${p.reference}`,
  },
  'owner-home-request': {
    owner: true,
    subject: (p) => `Home visit request to confirm: ${p.customerName}, ${p.when} · ${p.reference}`,
  },
  'owner-cancelled': {
    owner: true,
    subject: (p) => `Cancelled: ${p.customerName}, ${p.when} · ${p.reference}`,
  },
};

/** Pure: HTML → readable plain text for the email's text part. */
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<(br|\/p|\/h\d|\/tr|\/li|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render a message. EMAIL → { subject, html, text }; SMS → { text }.
 * Throws for unknown templates or a channel the template doesn't support.
 */
async function render(template, channel, payload) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`Unknown notification template: ${template}`);
  if (channel === 'SMS') {
    if (!t.sms) throw new Error(`Template ${template} has no SMS version`);
    return { text: t.sms(payload) };
  }
  const data = { ...helpers, p: payload, template, owner: !!t.owner };
  const body = await ejs.renderFile(path.join(VIEWS, `${template}.ejs`), data, { async: false });
  const html = await ejs.renderFile(path.join(VIEWS, 'layout.ejs'), {
    ...data,
    body,
    subject: t.subject(payload),
  });
  return { subject: t.subject(payload), html, text: htmlToText(body) };
}

module.exports = { TEMPLATES, render, htmlToText };
