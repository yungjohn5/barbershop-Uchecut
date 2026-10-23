// SMS provider (Termii). Only the notification worker calls this, and only when
// NOTIFY_MODE=live; it throws on failure so the outbox can retry. Swap the implementation,
// not the callers.
const env = require('../config/env');

/** Returns the provider message id. */
async function send({ to, message }) {
  if (!env.TERMII_API_KEY || !env.TERMII_SENDER_ID) throw new Error('Termii is not configured');
  const res = await fetch(`${env.TERMII_BASE_URL}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TERMII_API_KEY,
      to: to.replace(/^\+/, ''),
      from: env.TERMII_SENDER_ID,
      sms: message,
      type: 'plain',
      channel: 'generic',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.code && body.code !== 'ok')) {
    throw new Error(`Termii ${res.status}: ${body.message || 'send failed'}`);
  }
  return String(body.message_id || 'termii');
}

module.exports = { send };
