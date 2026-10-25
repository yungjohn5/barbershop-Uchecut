require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().default('Victory Barbershop <bookings@example.com>'),
  TERMII_API_KEY: z.string().optional().default(''),
  TERMII_SENDER_ID: z.string().optional().default(''),
  TERMII_BASE_URL: z.string().url().default('https://api.ng.termii.com'),
  // '' (default) = SMS on only when the Termii keys are set; 'true' / 'false' force it.
  SMS_ENABLED: z.enum(['', 'true', 'false']).optional().default(''),
  // log: messages are written to the console and the Notification table only, never sent.
  // Defaults to "live" in production and "log" everywhere else.
  NOTIFY_MODE: z.enum(['log', 'live']).optional(),
  // Outside production, live mode only messages these phones/emails (comma separated).
  NOTIFY_ALLOWLIST: z.string().optional().default(''),
  // Owner alerts (new booking, home request, cancellation); falls back to the shop email.
  OWNER_EMAIL: z.string().email().optional().or(z.literal('')).default(''),
  ADMIN_PASSWORD: z.string().optional().default(''),
  // Images. Server-only credentials (never sent to the browser). Required in production.
  CLOUDINARY_URL: z
    .string()
    .regex(
      /^cloudinary:\/\/[^:\s]+:[^@\s]+@[\w-]+$/,
      'must look like cloudinary://<key>:<secret>@<cloud_name>',
    )
    .optional()
    .or(z.literal(''))
    .default(''),
  CLOUDINARY_FOLDER: z
    .string()
    .regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i, 'use a folder path like victory/dev')
    .optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

// Values from .env.example or obviously guessable ones: refused in production.
const EXAMPLE_SECRETS = ['change-me-to-a-long-random-string'];
const EXAMPLE_ADMIN_PASSWORDS = ['change-me-please', 'barbershop2026', 'password123456'];

/** Pure: a SESSION_SECRET too weak for production. */
function weakSecret(s) {
  const v = String(s || '');
  if (v.length < 32 || EXAMPLE_SECRETS.includes(v)) return true;
  if (/change.?me|example|secret|password|default|qwerty|letmein/i.test(v)) return true;
  return new Set(v).size < 12; // e.g. "aaaa…" or "abcabc…"
}

/** Pure: production-only problems that should stop the app from starting. */
function productionProblems(e) {
  const problems = [];
  if (weakSecret(e.SESSION_SECRET)) {
    problems.push(
      'SESSION_SECRET is weak or the example value. Generate one with: node -e "console.log(require(`crypto`).randomBytes(48).toString(`hex`))"',
    );
  }
  if (
    e.ADMIN_PASSWORD &&
    (EXAMPLE_ADMIN_PASSWORDS.includes(e.ADMIN_PASSWORD) || e.ADMIN_PASSWORD.length < 12)
  ) {
    problems.push(
      'ADMIN_PASSWORD is the seed/example value or too short. Change it (or remove it after seeding).',
    );
  }
  if (!e.CLOUDINARY_URL) problems.push('CLOUDINARY_URL is required in production (images).');
  if (e.CLOUDINARY_FOLDER && !/prod/.test(e.CLOUDINARY_FOLDER)) {
    problems.push(
      `CLOUDINARY_FOLDER is "${e.CLOUDINARY_FOLDER}"; use the production folder (e.g. victory/prod).`,
    );
  }
  if (!e.APP_URL.startsWith('https://'))
    problems.push('APP_URL must start with https:// in production.');
  if ((e.NOTIFY_MODE || 'live') === 'live' && /@example\.(com|org|net)\b/i.test(e.MAIL_FROM || ''))
    problems.push('MAIL_FROM is the example sender; set the real "Shop name <bookings@domain>".');
  return problems;
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;
env.isProd = env.NODE_ENV === 'production';
env.NOTIFY_MODE = env.NOTIFY_MODE || (env.NODE_ENV === 'production' ? 'live' : 'log');
env.CLOUDINARY_FOLDER = env.CLOUDINARY_FOLDER || (env.isProd ? 'victory/prod' : 'victory/dev');
env.cloudinaryCloud = env.CLOUDINARY_URL ? env.CLOUDINARY_URL.split('@').pop() : '';
env.notifyAllowlist = env.NOTIFY_ALLOWLIST.split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
if (env.isProd) {
  const problems = productionProblems(env);
  if (problems.length) {
    const list = problems.map((p) => `  - ${p}`).join('\n');
    throw new Error(`Refusing to start in production:\n${list}`);
  }
}
// SMS (Termii) is optional: on when both keys are set, unless SMS_ENABLED says otherwise.
// While it's off, customers are messaged by email only and no SMS is queued.
env.smsEnabled =
  env.SMS_ENABLED === ''
    ? Boolean(env.TERMII_API_KEY && env.TERMII_SENDER_ID)
    : env.SMS_ENABLED === 'true';
if (env.NOTIFY_MODE === 'live') {
  const needed = ['SMTP_HOST', 'MAIL_FROM'];
  if (env.smsEnabled) needed.push('TERMII_API_KEY', 'TERMII_SENDER_ID');
  const missing = needed.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `NOTIFY_MODE=live needs: ${missing.join(', ')}. Set them, or use NOTIFY_MODE=log.`,
    );
  }
}
env.isTest = env.NODE_ENV === 'test';
env.isDev = env.NODE_ENV === 'development';

module.exports = env;
module.exports.weakSecret = weakSecret;
module.exports.productionProblems = productionProblems;
