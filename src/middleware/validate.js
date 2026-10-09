const { ValidationError } = require('../lib/errors');

// validate({ query, body, params }) with zod schemas; parsed values land on req.valid.
function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part]);
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        return next(new ValidationError('Invalid request', details));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

module.exports = { validate };
