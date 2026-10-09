// Minimal levelled logger; swap for pino later without touching call sites.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? 40 : 20);

function log(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  meta === undefined ? out(line) : out(line, meta);
}

module.exports = {
  debug: (m, meta) => log('debug', m, meta),
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
};
