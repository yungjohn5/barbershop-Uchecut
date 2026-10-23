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
  // log: messages are written to the console and the Notification table only, never sent.
  // Defaults to "live" in production and "log" everywhere else.
  NOTIFY_MODE: z.enum(['log', 'live']).optional(),
  // Outside production, live mode only messages these phones/emails (comma separated).
  NOTIFY_ALLOWLIST: z.string().optional().default(''),
  // Owner alerts (new booking, home request, cancellation); falls back to the shop email.
  OWNER_EMAIL: z.string().email().optional().or(z.literal('')).default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;
env.isProd = env.NODE_ENV === 'production';
env.NOTIFY_MODE = env.NOTIFY_MODE || (env.NODE_ENV === 'production' ? 'live' : 'log');
env.notifyAllowlist = env.NOTIFY_ALLOWLIST.split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
if (env.NOTIFY_MODE === 'live') {
  const missing = ['SMTP_HOST', 'MAIL_FROM', 'TERMII_API_KEY', 'TERMII_SENDER_ID'].filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(
      `NOTIFY_MODE=live needs: ${missing.join(', ')}. Set them, or use NOTIFY_MODE=log.`,
    );
  }
}
env.isTest = env.NODE_ENV === 'test';
env.isDev = env.NODE_ENV === 'development';

module.exports = env;
