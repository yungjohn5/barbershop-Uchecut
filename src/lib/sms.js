// Provider-agnostic SMS wrapper. Termii today; swap the implementation, not callers.
const env = require('../config/env');
const logger = require('./logger');

async function send({ to, message }) {
  if (!env.TERMII_API_KEY || !env.TERMII_SENDER_ID) {
    logger.info(`[sms:dry-run] to=${to} msg=${JSON.stringify(message)}`);
    return { ok: true, dryRun: true };
  }
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
  if (!res.ok) {
    logger.error(`[sms] Termii ${res.status}`, body);
    return { ok: false, status: res.status, body };
  }
  return { ok: true, id: body.message_id };
}

module.exports = { send };
