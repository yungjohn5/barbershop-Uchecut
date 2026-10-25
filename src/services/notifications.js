// Notification outbox. Booking changes call enqueueForEvent() inside their own transaction,
// so a message exists if and only if the change committed. The worker (src/jobs) calls
// sendDue(); delivery honours NOTIFY_MODE (log never touches a provider) and retries with
// backoff before marking a message FAILED (shown in the booking history).
const prisma = require('../lib/prisma');
const env = require('../config/env');
const logger = require('../lib/logger');
const settingsService = require('./settings');
const templates = require('./notifyTemplates');
const sms = require('../lib/sms');
const mailer = require('../lib/mailer');
const { formatShort, formatTime, formatDay } = require('../lib/viewHelpers');

const RETRY_DELAYS_MIN = [1, 5, 30]; // after the 1st, 2nd and 3rd failed attempt
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1; // then FAILED
const REMINDERS = ['reminder-24h', 'reminder-2h'];

// ---------------------------------------------------------------------------
// Payloads (snapshot of what the message needs, taken when it is queued)
// ---------------------------------------------------------------------------

const when = (d) => `${formatShort(d)}, ${formatTime(d)}`;

/** Pure: message data for a booking (needs services, barber, customer, zone). */
function payloadFor(booking, { shop, appUrl = env.APP_URL, extra = {} }) {
  const first = booking.services[0];
  const rebook = new URLSearchParams({ type: booking.type });
  if (first && first.serviceId) rebook.set('service', String(first.serviceId));
  if (booking.zoneId) rebook.set('zone', String(booking.zoneId));
  return {
    reference: booking.reference,
    type: booking.type,
    when: when(booking.startsAt),
    day: formatDay(booking.startsAt),
    time: formatTime(booking.startsAt),
    endTime: formatTime(booking.endsAt),
    startsAt: booking.startsAt.toISOString(),
    barber: booking.barber.name,
    services: booking.services.map((s) => s.name),
    totalKobo: booking.totalKobo,
    homeFeeKobo: booking.homeFeeKobo || 0,
    address: booking.address || null,
    landmark: booking.landmark || null,
    zone: booking.zone ? booking.zone.name : null,
    customerName: booking.customer.name,
    customerFirst: booking.customer.name.trim().split(/\s+/)[0],
    customerPhone: booking.customer.phone,
    customerEmail: booking.customer.email || null,
    manageUrl: `${appUrl}/manage/${booking.manageToken}`,
    bookUrl: `${appUrl}/book`,
    rebookUrl: `${appUrl}/book?${rebook}`,
    adminUrl: `${appUrl}/admin/bookings/${booking.id}`,
    shopName: shop.name,
    shopPhone: shop.phone,
    shopWhatsapp: shop.whatsapp,
    shopAddress: shop.address,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Enqueue (inside the caller's transaction)
// ---------------------------------------------------------------------------

/** Insert outbox rows; rows whose dedupeKey already exists are ignored. Returns the count added. */
async function enqueue(tx, rows) {
  if (!rows.length) return 0;
  const { count } = await tx.notification.createMany({ data: rows, skipDuplicates: true });
  return count;
}

/**
 * Customer rows for a template: SMS when SMS is on (phone is required), email when we have
 * one. While Termii isn't set up (env.smsEnabled false), customers get email only.
 */
function customerRows(booking, template, payload, keySuffix, sendAfter) {
  const t = templates.TEMPLATES[template];
  const rows = [];
  const base = { bookingId: booking.id, template, payload, ...(sendAfter ? { sendAfter } : {}) };
  if (t.sms && env.smsEnabled) {
    rows.push({
      ...base,
      channel: 'SMS',
      to: booking.customer.phone,
      dedupeKey: `${booking.reference}:${template}:SMS${keySuffix}`,
    });
  }
  if (booking.customer.email && template !== 'reminder-2h') {
    rows.push({
      ...base,
      channel: 'EMAIL',
      to: booking.customer.email,
      dedupeKey: `${booking.reference}:${template}:EMAIL${keySuffix}`,
    });
  }
  return rows;
}

function ownerRow(booking, template, payload, keySuffix, shop) {
  const to = env.OWNER_EMAIL || shop.email;
  if (!to) return [];
  return [
    {
      bookingId: booking.id,
      template,
      payload,
      channel: 'EMAIL',
      to,
      dedupeKey: `${booking.reference}:${template}:EMAIL${keySuffix}`,
    },
  ];
}

/** Mark unsent reminders as SKIPPED (the booking moved, was cancelled or has happened). */
function skipReminders(tx, bookingId, reason = 'Booking changed') {
  return tx.notification.updateMany({
    where: { bookingId, status: 'PENDING', template: { in: REMINDERS } },
    data: { status: 'SKIPPED', lastError: reason },
  });
}

/**
 * Queue the messages for a booking change. type: CREATED | CONFIRMED | RESCHEDULED |
 * CANCELLED | AUTO_CANCELLED | COMPLETED | NO_SHOW. opts: { by, reason, fromStartsAt, needsConfirm }.
 */
async function enqueueForEvent(tx, booking, type, opts = {}) {
  const shop = opts.shop || (await settingsService.get('shop'));
  const latest =
    type === 'CREATED'
      ? null
      : await tx.bookingEvent.findFirst({
          where: { bookingId: booking.id },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
  const suffix = latest ? `:${latest.id}` : '';
  const extra = {
    by: opts.by || null,
    reason: opts.reason || null,
    needsConfirm: !!opts.needsConfirm,
    fromWhen: opts.fromStartsAt ? when(opts.fromStartsAt) : null,
  };
  const payload = payloadFor(booking, { shop, extra });
  const rows = [];
  const fromWeb = booking.source === 'WEB';

  switch (type) {
    case 'CREATED':
      if (booking.status === 'PENDING') {
        rows.push(...customerRows(booking, 'home-received', payload, suffix));
        rows.push(...ownerRow(booking, 'owner-home-request', payload, suffix, shop));
      } else {
        rows.push(
          ...customerRows(
            booking,
            booking.type === 'HOME' ? 'home-confirmed' : 'shop-confirmed',
            payload,
            suffix,
          ),
        );
        if (fromWeb) rows.push(...ownerRow(booking, 'owner-new-booking', payload, suffix, shop));
      }
      break;
    case 'CONFIRMED':
      if (booking.type === 'HOME')
        rows.push(...customerRows(booking, 'home-confirmed', payload, suffix));
      break;
    case 'RESCHEDULED':
      await skipReminders(tx, booking.id, 'Booking moved');
      rows.push(...customerRows(booking, 'rescheduled', payload, suffix));
      break;
    case 'CANCELLED':
      await skipReminders(tx, booking.id, 'Booking cancelled');
      rows.push(...customerRows(booking, 'cancelled', payload, suffix));
      if (opts.by === 'customer')
        rows.push(...ownerRow(booking, 'owner-cancelled', payload, suffix, shop));
      break;
    case 'AUTO_CANCELLED':
      await skipReminders(tx, booking.id, 'Booking cancelled');
      rows.push(...customerRows(booking, 'auto-cancelled', payload, suffix));
      rows.push(
        ...ownerRow(booking, 'owner-cancelled', { ...payload, by: 'system' }, suffix, shop),
      );
      break;
    case 'COMPLETED':
    case 'NO_SHOW':
      await skipReminders(tx, booking.id, 'Appointment has happened');
      break;
    default:
      break;
  }
  return enqueue(tx, rows);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** For logs: never print full phone numbers, emails or manage tokens. */
function maskRecipient(to) {
  if (to.includes('@')) return to.replace(/^(.).*(@.*)$/, '$1***$2');
  return to.length > 7 ? `${to.slice(0, 4)}***${to.slice(-3)}` : '***';
}
const maskTokens = (text) => text.replace(/\/manage\/[A-Za-z0-9_-]{8,}/g, '/manage/…');

function allowed(to) {
  if (env.isProd) return true;
  return env.notifyAllowlist.includes(String(to).toLowerCase());
}

/**
 * Send one notification. mode 'log' renders and records it without calling a provider;
 * 'live' calls SMTP/Termii (outside production only for NOTIFY_ALLOWLIST recipients).
 */
async function deliver(n, { mode = env.NOTIFY_MODE, now = new Date(), db = prisma } = {}) {
  const attempts = n.attempts + 1;
  try {
    const msg = await templates.render(n.template, n.channel, n.payload);
    if (mode === 'log') {
      logger.info(
        { notification: n.id, channel: n.channel, template: n.template, to: maskRecipient(n.to) },
        `[notify:log] ${n.channel === 'SMS' ? maskTokens(msg.text) : msg.subject}`,
      );
      return db.notification.update({
        where: { id: n.id },
        data: { status: 'SENT', attempts, sentAt: now, providerRef: 'log', lastError: null },
      });
    }
    if (n.channel === 'SMS' && !env.smsEnabled) {
      // Queued before SMS was switched off: don't retry against a provider we don't have.
      return db.notification.update({
        where: { id: n.id },
        data: { status: 'SKIPPED', attempts, lastError: 'SMS is off (Termii not set up)' },
      });
    }
    if (!allowed(n.to)) {
      return db.notification.update({
        where: { id: n.id },
        data: {
          status: 'SKIPPED',
          attempts,
          lastError: 'Recipient not on NOTIFY_ALLOWLIST (non-production)',
        },
      });
    }
    const providerRef =
      n.channel === 'SMS'
        ? await sms.send({ to: n.to, message: msg.text })
        : await mailer.sendMail({ to: n.to, subject: msg.subject, html: msg.html, text: msg.text });
    return db.notification.update({
      where: { id: n.id },
      data: { status: 'SENT', attempts, sentAt: now, providerRef, lastError: null },
    });
  } catch (err) {
    const lastError = String(err.message || err).slice(0, 500);
    if (attempts >= MAX_ATTEMPTS) {
      logger.warn(
        { notification: n.id, template: n.template, channel: n.channel },
        `[notify] failed: ${lastError}`,
      );
      return db.$transaction(async (tx) => {
        if (n.bookingId) {
          await tx.bookingEvent.create({
            data: {
              bookingId: n.bookingId,
              type: 'NOTIFY_FAILED',
              actor: 'SYSTEM',
              note: `${n.channel === 'SMS' ? 'SMS' : 'Email'} “${n.template}” to ${maskRecipient(n.to)} failed after ${attempts} attempts: ${lastError}`,
            },
          });
        }
        return tx.notification.update({
          where: { id: n.id },
          data: { status: 'FAILED', attempts, lastError },
        });
      });
    }
    const sendAfter = new Date(now.getTime() + RETRY_DELAYS_MIN[attempts - 1] * 60_000);
    return db.notification.update({
      where: { id: n.id },
      data: { attempts, lastError, sendAfter },
    });
  }
}

/** Send everything that is due. Returns counts by resulting status. */
async function sendDue({ now = new Date(), limit = 50, mode, db = prisma } = {}) {
  const due = await db.notification.findMany({
    where: { status: 'PENDING', sendAfter: { lte: now } },
    orderBy: [{ sendAfter: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  const counts = { SENT: 0, FAILED: 0, SKIPPED: 0, RETRY: 0 };
  for (const n of due) {
    const out = await deliver(n, { mode, now, db });
    counts[out.status === 'PENDING' ? 'RETRY' : out.status] += 1;
  }
  return counts;
}

/** Admin "Resend" for a FAILED message: back to PENDING with a fresh set of attempts. */
async function resend(id, { now = new Date(), db = prisma } = {}) {
  const { count } = await db.notification.updateMany({
    where: { id, status: 'FAILED' },
    data: { status: 'PENDING', attempts: 0, lastError: null, sendAfter: now },
  });
  return count === 1;
}

module.exports = {
  RETRY_DELAYS_MIN,
  MAX_ATTEMPTS,
  REMINDERS,
  payloadFor,
  enqueue,
  enqueueForEvent,
  customerRows,
  skipReminders,
  deliver,
  sendDue,
  resend,
  maskRecipient,
  maskTokens,
};
