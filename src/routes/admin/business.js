// Customers (all admins), reports, settings and users (OWNER), and each admin's own account.
// Rules live in services/customers.js, reports.js, settingsAdmin.js and adminUsers.js.
const express = require('express');
const { NotFoundError } = require('../../lib/errors');
const { requireRole } = require('../../middleware/admin');
const customers = require('../../services/customers');
const reports = require('../../services/reports');
const settingsAdmin = require('../../services/settingsAdmin');
const settingsService = require('../../services/settings');
const adminUsers = require('../../services/adminUsers');
const { asyncRoute, setFlash, view, idParam, takeForm, formPost } = require('./helpers');

const router = express.Router();
const ownerOnly = requireRole('OWNER');

// ================================================================ customers
router.get(
  '/customers',
  asyncRoute(async (req, res) => {
    const sort = customers.SORTS[req.query.sort] ? req.query.sort : 'recent';
    const page = Math.min(500, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const q = String(req.query.q || '').slice(0, 80);
    const result = await customers.listCustomers({ q, sort, page });
    view(req, res, 'customers/index', { title: 'Customers', nav: 'customers', q, sort, ...result });
  }),
);

router.get(
  '/customers/:id',
  asyncRoute(async (req, res, next) => {
    const data = await customers.getCustomer(idParam(req));
    if (!data) return next(new NotFoundError('Customer not found'));
    const form = takeForm(req, `customer-${data.customer.id}`);
    view(req, res, 'customers/show', {
      title: data.customer.name,
      nav: 'customers',
      ...data,
      now: new Date(),
      errors: form.errors,
      values: form.values || data.customer,
    });
  }),
);

router.post(
  '/customers/:id',
  formPost(
    (req) => `customer-${idParam(req)}`,
    (req) => `/admin/customers/${idParam(req)}`,
    async (req, res) => {
      const c = await customers.updateCustomer(idParam(req), req.body);
      setFlash(req, 'success', `${c.name}’s details saved.`);
      res.redirect(303, `/admin/customers/${c.id}`);
    },
  ),
);

// ================================================================ reports
router.get(
  '/reports',
  ownerOnly,
  asyncRoute(async (req, res) => {
    const query = {
      preset: req.query.preset || (req.query.from && req.query.to ? undefined : 'month'),
      from: req.query.from,
      to: req.query.to,
    };
    view(req, res, 'reports', {
      title: 'Reports',
      nav: 'reports',
      ...(await reports.buildReport(query)),
    });
  }),
);

// ================================================================ settings
router.get(
  '/settings',
  ownerOnly,
  asyncRoute(async (req, res) => {
    const current = settingsAdmin.formValues(await settingsService.getAll({ fresh: true }));
    const forms = {};
    for (const s of ['booking', 'shop', 'home']) {
      const f = takeForm(req, `settings-${s}`);
      forms[s] = { values: f.values || current[s], errors: f.errors };
    }
    view(req, res, 'settings', { title: 'Settings', nav: 'settings', forms });
  }),
);

const SECTION_LABEL = { booking: 'Booking rules', shop: 'Shop details', home: 'Home page copy' };
router.post(
  '/settings/:section',
  ownerOnly,
  formPost(
    (req) => `settings-${req.params.section}`,
    (req) => `/admin/settings#${req.params.section}`,
    async (req, res) => {
      const { section } = req.params;
      if (!SECTION_LABEL[section]) throw new NotFoundError('Unknown settings section');
      if (req.body.reset === '1') {
        await settingsAdmin.resetSection(section);
        setFlash(req, 'success', `${SECTION_LABEL[section]} restored to the defaults.`);
      } else {
        await settingsAdmin.saveSection(section, req.body);
        setFlash(
          req,
          'success',
          `${SECTION_LABEL[section]} saved. The site updates straight away.`,
        );
      }
      res.redirect(303, `/admin/settings#${section}`);
    },
  ),
);

// ================================================================ users
router.get(
  '/users',
  ownerOnly,
  asyncRoute(async (req, res) => {
    view(req, res, 'users', {
      title: 'Users',
      nav: 'users',
      users: await adminUsers.listAdmins(),
      newForm: takeForm(req, 'user-new'),
      now: new Date(),
    });
  }),
);

router.post(
  '/users',
  ownerOnly,
  formPost('user-new', '/admin/users#new', async (req, res) => {
    const a = await adminUsers.createAdmin(req.body);
    setFlash(
      req,
      'success',
      `Account created for ${a.name}. Share the password with them privately.`,
    );
    res.redirect(303, '/admin/users');
  }),
);

router.post(
  '/users/:id',
  ownerOnly,
  formPost('noop', '/admin/users', async (req, res) => {
    const a = await adminUsers.updateAdmin(idParam(req), req.body, { actorId: req.admin.id });
    setFlash(req, 'success', `${a.name} saved.`);
    res.redirect(303, '/admin/users');
  }),
);

router.post(
  '/users/:id/active',
  ownerOnly,
  formPost('noop', '/admin/users', async (req, res) => {
    const a = await adminUsers.setActive(idParam(req), req.body.active === 'true', {
      actorId: req.admin.id,
    });
    setFlash(
      req,
      'success',
      a.active ? `${a.name} can sign in again.` : `${a.name} is deactivated and signed out.`,
    );
    res.redirect(303, '/admin/users');
  }),
);

router.post(
  '/users/:id/password',
  ownerOnly,
  formPost('noop', '/admin/users', async (req, res) => {
    await adminUsers.resetPassword(idParam(req), req.body.password);
    setFlash(
      req,
      'success',
      'Password reset. They’ve been signed out everywhere and can sign in with the new one.',
    );
    res.redirect(303, '/admin/users');
  }),
);

// ================================================================ my account
router.get(
  '/account',
  asyncRoute(async (req, res) => {
    const form = takeForm(req, 'account');
    view(req, res, 'account', { title: 'Your account', nav: 'account', errors: form.errors });
  }),
);

router.post(
  '/account/password',
  formPost('account', '/admin/account', async (req, res) => {
    await adminUsers.changeOwnPassword(req.admin.id, req.body, { sid: req.sessionID });
    setFlash(req, 'success', 'Password changed. Other devices have been signed out.');
    res.redirect(303, '/admin/account');
  }),
);

module.exports = router;
