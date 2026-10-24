// Structured logging with pino. No PII: phone numbers, emails and addresses are redacted
// wherever they appear in logged objects, and URLs are cleaned before logging (manage-link
// tokens and phone/search query values masked). Call as logger.info({ ...fields }, 'message').
const pino = require('pino');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

const PII = [
  'phone',
  'email',
  'address',
  'landmark',
  'to',
  'customerPhone',
  'customerEmail',
  'password',
];

const options = {
  level,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      ...PII,
      ...PII.map((k) => `*.${k}`),
    ],
    censor: '[redacted]',
  },
};

const logger = pino(options);

const SENSITIVE_QUERY = /^(phone|q|email|token|password)$/i;

/** Pure: a URL safe to log: manage tokens shortened, sensitive query values hidden. */
function safeUrl(url) {
  const [path, query] = String(url || '').split('?');
  const cleanPath = path.replace(/\/manage\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/, '/manage/$1…');
  if (!query) return cleanPath;
  const params = query
    .split('&')
    .map((pair) => {
      const [k] = pair.split('=');
      return SENSITIVE_QUERY.test(decodeURIComponent(k || '')) ? `${k}=…` : pair;
    })
    .join('&');
  return `${cleanPath}?${params}`;
}

module.exports = logger;
module.exports.safeUrl = safeUrl;
module.exports.options = options;
