const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('./logger');

// Without SMTP settings, emails are serialised and logged instead of sent.
const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

async function sendMail({ to, subject, html, text }) {
  const info = await transport.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  if (!env.SMTP_HOST) logger.info(`[mail:dry-run] to=${to} subject=${JSON.stringify(subject)}`);
  return info;
}

module.exports = { sendMail };
