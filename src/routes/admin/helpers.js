// Shared helpers for the admin routers: flash messages, view rendering and PRG form state.
const { ValidationError, HttpError } = require('../../lib/errors');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function takeFlash(req) {
  const f = req.session.adminFlash;
  delete req.session.adminFlash;
  return f || null;
}
function setFlash(req, type, message) {
  req.session.adminFlash = { type, message };
}
function view(req, res, name, data = {}) {
  res.render(`admin/${name}`, { layout: 'layouts/admin', flash: takeFlash(req), ...data });
}

/** Same-site admin referer, else the fallback. */
function back(req, fallback) {
  const ref = req.get('referer') || '';
  try {
    const u = new URL(ref);
    return u.pathname.startsWith('/admin') ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
}
const idParam = (req) => Number.parseInt(req.params.id, 10);

// ---- PRG form state: values + field errors survive one redirect.
function keepForm(req, key, values, err) {
  const errors = {};
  for (const d of err.details || [])
    errors[d.path || '_form'] = errors[d.path || '_form'] || d.message;
  if (!Object.keys(errors).length) errors._form = err.message;
  // Never keep secrets in the session: password fields are dropped, not redisplayed.
  const rest = Object.fromEntries(
    Object.entries(values || {}).filter(
      ([k]) => k !== '_csrf' && !/password|current|confirm/i.test(k),
    ),
  );
  req.session.adminForms = { ...(req.session.adminForms || {}), [key]: { values: rest, errors } };
}
function takeForm(req, key) {
  const all = req.session.adminForms || {};
  const f = all[key];
  if (f) {
    delete all[key];
    req.session.adminForms = all;
  }
  return f || { values: null, errors: {} };
}

/**
 * Wrap a form POST: validation errors go back to `errorTo` with the input kept (PRG);
 * 4xx HttpErrors become an error flash. `key` names the form state.
 */
function formPost(key, errorTo, fn) {
  return asyncRoute(async (req, res) => {
    const to = typeof errorTo === 'function' ? errorTo(req) : errorTo;
    try {
      if (req.uploadError)
        throw new ValidationError(req.uploadError, [{ path: 'image', message: req.uploadError }]);
      await fn(req, res);
    } catch (err) {
      if (err instanceof ValidationError) {
        keepForm(req, typeof key === 'function' ? key(req) : key, req.body, err);
        setFlash(req, 'error', err.message);
        return res.redirect(303, to);
      }
      if (err instanceof HttpError && err.status < 500) {
        setFlash(req, 'error', err.message);
        return res.redirect(303, back(req, to));
      }
      throw err;
    }
  });
}

module.exports = {
  asyncRoute,
  takeFlash,
  setFlash,
  view,
  back,
  idParam,
  keepForm,
  takeForm,
  formPost,
};
