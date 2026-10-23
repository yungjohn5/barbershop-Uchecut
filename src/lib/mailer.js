// Email provider (SMTP via nodemailer). Only the notification worker calls this, and only
// when NOTIFY_MODE=live; it throws on failure so the outbox can retry.
const nodemailer = require('nodemailer');
const env = require('../config/env');

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/** Returns the provider message id. */
async function sendMail({ to, subject, html, text }) {
  if (!env.SMTP_HOST) throw new Error('SMTP is not configured');
  const info = await getTransport().sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  return info.messageId || 'smtp';
}

module.exports = { sendMail };
