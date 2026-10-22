// Admin dashboard (Wave A): sign-in, Today, bookings, calendar, staff bookings.
// Routes stay thin; rules live in services/adminBookings.js and services/booking.js.
const express = require('express');
const { z } = require('zod');
const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { loginLimiter, apiLimiter } = require('../../middleware/rateLimits');
const { loadAdmin, requireAdmin, safeNext } = require('../../middleware/admin');
const { SlotTakenError, ValidationError, HttpError, NotFoundError } = require('../../lib/errors');
const { isValidDateStr, toShopDate, addDays } = require('../../lib/time');
const { normaliseNgPhone } = require('../../lib/phone');
const { authenticate } = require('../../services/adminAuth');
const adminBookings = require('../../services/adminBookings');
const { getSlots, computeDay, staffSettings } = require('../../services/availability');
const { createBooking, rescheduleBooking } = require('../../services/booking');
const flow = require('../../services/bookingFlow');
const settingsService = require('../../services/settings');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(loadAdmin);

// ---------------------------------------------------------------- helpers
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
const back = (req, fallback) => {
  const ref = req.get('referer') || '';
  try {
    const u = new URL(ref);
    return u.pathname.startsWith('/admin') ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
};
const idParam = (req) => Number.parseInt(req.params.id, 10);

// ---------------------------------------------------------------- sign in / out
router.get('/login', (req, res) => {
  if (req.admin) return res.redirect(safeNext(req.query.next));
  view(req, res, 'login', { title: 'Sign in', next: safeNext(req.query.next), email: '', error: null });
});

router.post(
  '/login',
  loginLimiter,
  asyncRoute(async (req, res, next) => {
    const email = String(req.body.email || '');
    const result = await authenticate(email, req.body.password);
    if (!result.ok) {
      res.status(401);
      return view(req, res, 'login', { title: 'Sign in', next: safeNext(req.body.next), email, error: result.reason });
    }
    // New session id on sign-in (prevents session fixation).
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminId = result.admin.id;
      req.session.save((e) => (e ? next(e) : res.redirect(safeNext(req.body.next))));
    });
  }),
);

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('vb.sid');
    res.redirect('/admin/login');
  });
});

// Everything below needs a signed-in admin.
router.use(requireAdmin);

// Sidebar badge: upcoming home-visit requests awaiting confirmation.
router.use(
  asyncRoute(async (req, res, next) => {
    res.locals.pendingCount = await prisma.booking.count({ where: { status: 'PENDING', startsAt: { gte: new Date() } } });
    next();
  }),
);

// ---------------------------------------------------------------- Today
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const data = await adminBookings.todayOverview();
    view(req, res, 'dashboard', { title: 'Today', nav: 'today', ...data, actionsFor: (b) => adminBookings.allowedActions(b, data.now) });
  }),
);

// ---------------------------------------------------------------- bookings
const listQuery = z.object({
  scope: z.enum(['upcoming', 'today', 'pending', 'past', 'all']).optional(),
  q: z.string().max(80).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  barber: z.coerce.number().int().positive().optional(),
  type: z.enum(['SHOP', 'HOME']).optional().or(z.literal('')),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/bookings',
  asyncRoute(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    const f = parsed.success ? parsed.data : {};
    const [result, barbers] = await Promise.all([
      adminBookings.listBookings(
        { scope: f.scope, q: f.q, from: f.from, to: f.to, barberId: f.barber, type: f.type, status: f.status },
        { page: f.page || 1 },
      ),
      prisma.barber.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    ]);
    view(req, res, 'bookings/index', { title: 'Bookings', nav: 'bookings', filters: f, barbers, ...result });
  }),
);

// Staff booking (walk-ins / phone). Declared before /bookings/:id.
router.get(
  '/bookings/new',
  asyncRoute(async (req, res) => {
    const ctx = await flow.loadContext({ type: 'SHOP' });
    const zones = ctx.zones;
    const [categories, barbers] = await Promise.all([
      prisma.serviceCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { services: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
      }),
      prisma.barber.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    ]);
    const days = flow.dateStrip({ today: ctx.today, days: 30, openWeekdays: ctx.openWeekdays });
    view(req, res, 'bookings/new', {
      title: 'New booking',
      nav: 'new',
      zones,
      categories: categories.filter((c) => c.services.length),
      barbers,
      days,
      today: ctx.today,
      values: req.session.staffDraft || {},
      errors: takeErrors(req),
    });
  }),
);

function takeErrors(req) {
  const e = req.session.staffErrors;
  delete req.session.staffErrors;
  return e || {};
}

router.post(
  '/bookings',
  asyncRoute(async (req, res) => {
    const b = req.body;
    const values = {
      type: b.type === 'HOME' ? 'HOME' : 'SHOP',
      zoneId: b.zoneId ? Number(b.zoneId) : null,
      serviceIds: [].concat(b.serviceIds || []).map(Number).filter((n) => n > 0),
      barberId: b.barberId && b.barberId !== 'any' ? Number(b.barberId) : 'any',
      date: b.date,
      startsAt: b.startsAt,
      name: String(b.name || '').trim(),
      phone: String(b.phone || '').trim(),
      email: String(b.email || '').trim(),
      address: String(b.address || '').trim(),
      landmark: String(b.landmark || '').trim(),
      notes: String(b.notes || '').trim(),
    };
    req.session.staffDraft = values;
    try {
      const booking = await createBooking(
        {
          type: values.type,
          serviceIds: values.serviceIds,
          zoneId: values.type === 'HOME' ? values.zoneId : null,
          barberId: values.barberId,
          startsAt: values.startsAt,
          customer: { name: values.name, phone: values.phone, email: values.email },
          address: values.address || undefined,
          landmark: values.landmark || undefined,
          notes: values.notes || undefined,
        },
        { actor: 'staff' },
      );
      delete req.session.staffDraft;
      setFlash(req, 'success', `Booked ${booking.reference} for ${booking.customer.name}.`);
      return res.redirect(303, `/admin/bookings/${booking.id}`);
    } catch (err) {
      if (err instanceof SlotTakenError) {
        req.session.staffErrors = { startsAt: 'That time was just taken. Pick another.' };
      } else if (err instanceof ValidationError) {
        const errors = {};
        for (const d of err.details || []) {
          const k = String(d.path).replace(/^customer\./, '');
          errors[k] = errors[k] || d.message;
        }
        if (!values.startsAt) errors.startsAt = 'Choose a time.';
        if (!Object.keys(errors).length) errors._form = err.message;
        req.session.staffErrors = errors;
      } else {
        throw err;
      }
      return res.redirect(303, '/admin/bookings/new');
    }
  }),
);

router.get(
  '/bookings/:id',
  asyncRoute(async (req, res, next) => {
    const booking = await adminBookings.getBooking(idParam(req));
    if (!booking) return next(new NotFoundError('Booking not found'));
    const history = await prisma.booking.findMany({
      where: { customerId: booking.customerId, id: { not: booking.id } },
      orderBy: { startsAt: 'desc' },
      take: 5,
      include: { services: true },
    });
    view(req, res, 'bookings/show', {
      title: booking.reference,
      nav: 'bookings',
      booking,
      history,
      actions: adminBookings.allowedActions(booking, new Date()),
      when: flow.formatWhen(booking.startsAt),
      day: flow.formatDay(booking.startsAt),
      time: flow.formatTime(booking.startsAt),
      endTime: flow.formatTime(booking.endsAt),
      manageUrl: `${env.APP_URL}/manage/${booking.manageToken}`,
    });
  }),
);

router.post(
  '/bookings/:id/status',
  asyncRoute(async (req, res) => {
    const id = idParam(req);
    try {
      const { message } = await adminBookings.applyAction(id, String(req.body.action || ''), { reason: req.body.reason });
      setFlash(req, 'success', message);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      setFlash(req, 'error', err.message);
    }
    res.redirect(303, back(req, `/admin/bookings/${id}`));
  }),
);

router.post(
  '/bookings/:id/notes',
  asyncRoute(async (req, res) => {
    const id = idParam(req);
    await adminBookings.updateStaffNotes(id, req.body.staffNotes);
    setFlash(req, 'success', 'Notes saved.');
    res.redirect(303, `/admin/bookings/${id}`);
  }),
);

router.get(
  '/bookings/:id/reschedule',
  asyncRoute(async (req, res, next) => {
    const booking = await adminBookings.getBooking(idParam(req));
    if (!booking) return next(new NotFoundError('Booking not found'));
    if (!adminBookings.allowedActions(booking, new Date()).includes('reschedule')) {
      setFlash(req, 'error', 'This booking can’t be moved now.');
      return res.redirect(`/admin/bookings/${booking.id}`);
    }
    const ctx = await flow.loadContext({
      type: booking.type,
      zoneId: booking.zoneId,
      serviceIds: booking.services.map((s) => s.serviceId),
    });
    let barberId = req.query.barber ?? String(booking.barberId);
    barberId = barberId === 'any' ? 'any' : Number(barberId);
    if (barberId !== 'any' && !ctx.barbers.some((x) => x.id === barberId)) barberId = 'any';
    const date = isValidDateStr(req.query.date) ? req.query.date : toShopDate(booking.startsAt);
    const slots = await staffSlotsExcluding(booking, { date, barberId });
    view(req, res, 'bookings/reschedule', {
      title: `Move ${booking.reference}`,
      nav: 'bookings',
      booking,
      ctx,
      date,
      barberId,
      when: flow.formatWhen(booking.startsAt),
      days: flow.dateStrip({ today: ctx.today, days: 60, openWeekdays: ctx.openWeekdays }),
      groups: flow.groupSlots(slots.slots),
      slotsError: slots.error,
    });
  }),
);

async function staffSlotsExcluding(booking, { date, barberId }) {
  try {
    const settings = staffSettings(await settingsService.getAll());
    const { slots } = await computeDay(
      prisma,
      {
        date,
        barberId,
        serviceIds: booking.services.map((s) => s.serviceId),
        type: booking.type,
        zoneId: booking.zoneId,
        excludeBookingId: booking.id,
      },
      { now: new Date(), settings: { ...settings, bookingWindowDays: 60 } },
    );
    return { slots, error: null };
  } catch (err) {
    if (err instanceof ValidationError) return { slots: [], error: err.message };
    throw err;
  }
}

router.post(
  '/bookings/:id/reschedule',
  asyncRoute(async (req, res, next) => {
    const booking = await adminBookings.getBooking(idParam(req));
    if (!booking) return next(new NotFoundError('Booking not found'));
    try {
      await rescheduleBooking(
        booking.manageToken,
        { startsAt: req.body.startsAt, barberId: req.body.barberId || 'any' },
        { staff: true },
      );
      setFlash(req, 'success', 'Booking moved.');
      res.redirect(303, `/admin/bookings/${booking.id}`);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      setFlash(req, 'error', err instanceof SlotTakenError ? 'That time was just taken. Pick another.' : err.message);
      res.redirect(303, `/admin/bookings/${booking.id}/reschedule`);
    }
  }),
);

// ---------------------------------------------------------------- calendar
router.get(
  '/calendar',
  asyncRoute(async (req, res) => {
    const barberId = req.query.barber ? Number(req.query.barber) : null;
    const data = await adminBookings.weekCalendar({ date: req.query.date, barberId });
    view(req, res, 'calendar', {
      title: 'Calendar',
      nav: 'calendar',
      ...data,
      prevWeek: addDays(data.start, -7),
      nextWeek: addDays(data.start, 7),
      thisWeek: adminBookings.weekStartOf(toShopDate(new Date())),
    });
  }),
);

// ---------------------------------------------------------------- admin JSON
router.get(
  '/api/slots',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const date = isValidDateStr(req.query.date) ? req.query.date : null;
    const services = String(req.query.services || '')
      .split(',')
      .map(Number)
      .filter((n) => n > 0);
    if (!date || !services.length) return res.json({ date, slots: [], error: services.length ? 'Pick a date.' : 'Choose a service first.' });
    try {
      const result = await getSlots(
        {
          date,
          barberId: req.query.barber && req.query.barber !== 'any' ? Number(req.query.barber) : 'any',
          serviceIds: services,
          type: req.query.type === 'HOME' ? 'HOME' : 'SHOP',
          zoneId: req.query.zone ? Number(req.query.zone) : null,
        },
        { staff: true },
      );
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.json({ date, slots: [], error: err.message });
      throw err;
    }
  }),
);

// Phone lookup for the staff form: returns the existing customer, if any.
router.get(
  '/api/customer',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const phone = normaliseNgPhone(String(req.query.phone || ''));
    if (!phone) return res.json({ customer: null });
    const c = await prisma.customer.findUnique({
      where: { phone },
      select: { id: true, name: true, email: true, noShowCount: true, _count: { select: { bookings: true } } },
    });
    res.json({ customer: c });
  }),
);

module.exports = router;
