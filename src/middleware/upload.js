// Multipart parsing for admin image forms. Mounted before CSRF protection so the hidden
// `_csrf` field is readable; files stay in memory (8 MB cap) and only reach a handler
// after CSRF and requireAdmin have passed.
const multer = require('multer');

const MAX_BYTES = 8 * 1024 * 1024;

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 60, fieldSize: 20 * 1024 },
}).single('image');

function parseMultipart(req, res, next) {
  if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
  parser(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      // Keep going so the route can show a friendly message; CSRF still applies.
      req.body = req.body || {};
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 8 MB or smaller.'
          : 'That upload didn’t work. Try again.';
      return next();
    }
    next(err);
  });
}

module.exports = { parseMultipart, MAX_BYTES };
