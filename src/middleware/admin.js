// Admin session: load the signed-in admin, require sign-in, require a role.
const prisma = require('../lib/prisma');

/** Attach req.admin / res.locals.admin when the session holds an active admin. */
async function loadAdmin(req, res, next) {
  try {
    const id = req.session.adminId;
    if (id) {
      const admin = await prisma.admin.findUnique({ where: { id } });
      if (admin && admin.active) {
        req.admin = admin;
      } else {
        delete req.session.adminId; // deactivated or deleted: sign out
      }
    }
    res.locals.admin = req.admin || null;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  if (req.method === 'GET' && !req.originalUrl.startsWith('/admin/api/')) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.' } });
}

/** requireRole('OWNER') — staff accounts get a friendly 403 page. */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (req.admin && roles.includes(req.admin.role)) return next();
    res.status(403).render('admin/forbidden', { layout: 'layouts/admin', title: 'Owner only', nav: null });
  };

/** Only same-site paths are allowed as a post-login redirect. */
function safeNext(next) {
  const s = String(next || '');
  return s.startsWith('/admin') && !s.startsWith('//') && !s.includes('\\') ? s : '/admin';
}

module.exports = { loadAdmin, requireAdmin, requireRole, safeNext };
