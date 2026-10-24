// Booking wizard (/book…), confirmation and the customer's manage link (/manage/:token).
// Routes are thin: validate input, update the session draft, call services, redirect.
const express = require('express');
const { z } = require('zod');
const env = require('../config/env');
const { bookingLimiter, apiLimiter, manageLimiter } = require('../middleware/rateLimits');
const { SlotTakenError, ValidationError, NotFoundError } = require('../lib/errors');
const prisma = require('../lib/prisma');
const { isValidDateStr, addDays, toShopDate } = require('../lib/time');
const { buildIcs } = require('../lib/ics');
const { getSlots, computeDay } = require('../services/availability');
const flow = require('../services/bookingFlow');
const { homeVisitsOpen } = require('../services/content');
const {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getBookingByToken,
  canModify,
} = require('../services/booking');
const settingsService = require('../services/settings');

const router = express.Router();
router.use('/manage', manageLimiter);
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- helpers
const draftOf = (req) => (req.session.booking = req.session.booking || {});

function takeFlash(req) {
  const f = req.session.flash;
  delete req.session.flash;
  return f || null;
}
function takeFormErrors(req) {
  const e = req.session.formErrors;
  delete req.session.formErrors;
  return e || {};
}
function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

const ORDER = flow.STEPS.map((s) => s.key);
const requireStep = (step) => (req, res, next) => {
  const frontier = flow.nextIncompleteStep(draftOf(req));
  if (ORDER.indexOf(frontier) < ORDER.indexOf(step)) {
    return res.redirect(flow.STEPS[ORDER.indexOf(frontier)].path);
  }
  next();
};

/** Data for the summary panel / mobile bar. */
function summaryOf(ctx, draft) {
  const services = ctx.selection ? ctx.selection.services : [];
  return {
    type: ctx.type,
    zone: ctx.zone,
    services,
    serviceMin: ctx.selection ? ctx.selection.serviceMin : 0,
    subtotalKobo: ctx.selection ? ctx.selection.subtotalKobo : 0,
    homeFeeKobo: ctx.selection ? ctx.selection.homeFeeKobo : ctx.zone ? ctx.zone.feeKobo : 0,
    totalKobo: ctx.selection ? ctx.selection.totalKobo : ctx.zone ? ctx.zone.feeKobo : 0,
    barber: ctx.barber,
    anyBarber: draft.barberId === 'any' || draft.barberId == null,
    when: draft.startsAt ? flow.formatWhen(draft.startsAt) : null,
  };
}

async function renderStep(req, res, step, view, extra = {}) {
  const draft = draftOf(req);
  const ctx = await flow.loadContext(draft);
  res.render(view, {
    title: 'Book',
    page: 'book',
    step,
    steps: flow.stepStates(step, draft),
    draft,
    ctx,
    summary: summaryOf(ctx, draft),
    flash: takeFlash(req),
    ...extra,
  });
}

/** Slots for a date, or an empty list with a friendly message instead of a 400. */
async function safeSlots(query) {
  try {
    const result = await getSlots(query);
    return { slots: result.slots, error: null };
  } catch (err) {
    if (err instanceof ValidationError) return { slots: [], error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------- 1. visit type
router.get(
  '/book',
  asyncRoute(async (req, res) => {
    req.session.booking = flow.applyPrefill(draftOf(req), req.query);
    await renderStep(req, res, 'type', 'booking/type');
  }),
);

const typeBody = z.object({
  type: z.enum(['SHOP', 'HOME']),
  zoneId: z.coerce.number().int().positive().optional(),
});
router.post(
  '/book/type',
  asyncRoute(async (req, res) => {
    const parsed = typeBody.safeParse(req.body);
    if (!parsed.success) {
      setFlash(req, 'error', 'Choose where you’d like your appointment.');
      return res.redirect('/book');
    }
    const { type, zoneId } = parsed.data;
    const draft = draftOf(req);
    if (type === 'HOME' && !(await homeVisitsOpen())) {
      delete draft.type;
      setFlash(
        req,
        'error',
        'Home visits are paused right now. Book in the shop, or message us on WhatsApp.',
      );
      return res.redirect('/book');
    }
    if (type === 'HOME' && !zoneId) {
      draft.type = 'HOME';
      setFlash(req, 'error', 'Choose your area for the home visit.');
      return res.redirect('/book');
    }
    if (draft.type !== type || draft.zoneId !== (type === 'HOME' ? zoneId : undefined))
      delete draft.startsAt;
    draft.type = type;
    if (type === 'HOME') draft.zoneId = zoneId;
    else delete draft.zoneId;
    res.redirect('/book/services');
  }),
);

// ---------------------------------------------------------------- 2. services
router.get(
  '/book/services',
  requireStep('services'),
  asyncRoute(async (req, res) => renderStep(req, res, 'services', 'booking/services')),
);

router.post(
  '/book/services',
  requireStep('services'),
  asyncRoute(async (req, res) => {
    const raw = [].concat(req.body.serviceIds || []);
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(
      0,
      10,
    );
    const draft = draftOf(req);
    const ctx = await flow.loadContext({ ...draft, serviceIds: ids });
    if (!ctx.chosenIds.length) {
      setFlash(req, 'error', 'Choose at least one service.');
      return res.redirect('/book/services');
    }
    if (String(ctx.chosenIds) !== String(draft.serviceIds || [])) delete draft.startsAt;
    draft.serviceIds = ctx.chosenIds;
    // A barber picked earlier who can't do these services falls back to "any".
    if (typeof draft.barberId === 'number' && !ctx.barbers.some((b) => b.id === draft.barberId)) {
      draft.barberId = 'any';
    }
    res.redirect('/book/time');
  }),
);

// ---------------------------------------------------------------- 3. barber + time
router.get(
  '/book/time',
  requireStep('time'),
  asyncRoute(async (req, res) => {
    const draft = draftOf(req);
    const ctx = await flow.loadContext(draft);
    const window = ctx.settings.bookingWindowDays;
    const lastDate = addDays(ctx.today, window);

    let barberId = req.query.barber ?? draft.barberId ?? 'any';
    barberId = barberId === 'any' ? 'any' : Number(barberId);
    if (barberId !== 'any' && !ctx.barbers.some((b) => b.id === barberId)) barberId = 'any';

    const fromDraft = draft.startsAt ? toShopDate(new Date(draft.startsAt)) : null;
    let date = isValidDateStr(req.query.date) ? req.query.date : fromDraft;
    const slotsFor = (d) =>
      safeSlots({
        date: d,
        barberId,
        serviceIds: ctx.chosenIds,
        type: ctx.type,
        zoneId: ctx.zone ? ctx.zone.id : null,
      });

    // No date chosen yet: open on the first day that actually has free times (home visits
    // never have any today because of the 24-hour lead time).
    let result;
    if (!date || date < ctx.today || date > lastDate) {
      ({ date, result } = await flow.firstAvailableDate({
        today: ctx.today,
        window,
        openWeekdays: ctx.openWeekdays,
        slotsFor,
      }));
    } else {
      result = await slotsFor(date);
    }
    const { slots, error } = result;
    await renderStep(req, res, 'time', 'booking/time', {
      date,
      barberId,
      days: flow.dateStrip({ today: ctx.today, days: window, openWeekdays: ctx.openWeekdays }),
      groups: flow.groupSlots(slots),
      slotsError: error,
      selectedStart: draft.startsAt || null,
      slotsQuery: {
        services: ctx.chosenIds.join(','),
        type: ctx.type,
        zone: ctx.zone ? ctx.zone.id : '',
      },
    });
  }),
);

const timeBody = z.object({
  startsAt: z.string().datetime(),
  barberId: z.union([z.literal('any'), z.coerce.number().int().positive()]).default('any'),
});
router.post(
  '/book/time',
  requireStep('time'),
  asyncRoute(async (req, res) => {
    const parsed = timeBody.safeParse(req.body);
    if (!parsed.success) {
      setFlash(req, 'error', 'Choose a time to continue.');
      return res.redirect('/book/time');
    }
    const draft = draftOf(req);
    const ctx = await flow.loadContext(draft);
    const { startsAt, barberId } = parsed.data;
    const shopDate = toShopDate(new Date(startsAt));
    const { slots } = await safeSlots({
      date: shopDate,
      barberId,
      serviceIds: ctx.chosenIds,
      type: ctx.type,
      zoneId: ctx.zone ? ctx.zone.id : null,
    });
    if (!slots.some((s) => s.startsAt === new Date(startsAt).toISOString())) {
      setFlash(req, 'error', 'That time is no longer available. Please pick another.');
      return res.redirect(`/book/time?date=${shopDate}`);
    }
    draft.startsAt = new Date(startsAt).toISOString();
    draft.barberId = barberId;
    res.redirect('/book/details');
  }),
);

// ---------------------------------------------------------------- 4. details + submit
router.get(
  '/book/details',
  requireStep('details'),
  asyncRoute(async (req, res) =>
    renderStep(req, res, 'details', 'booking/details', {
      values: draftOf(req).customer || {},
      errors: takeFormErrors(req),
    }),
  ),
);

router.post(
  '/book',
  bookingLimiter,
  requireStep('details'),
  asyncRoute(async (req, res) => {
    const draft = draftOf(req);
    const values = {
      name: String(req.body.name || '').trim(),
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),
      address: String(req.body.address || '').trim(),
      landmark: String(req.body.landmark || '').trim(),
      notes: String(req.body.notes || '').trim(),
    };
    draft.customer = values; // keep what they typed if anything goes wrong

    try {
      const booking = await createBooking({
        type: draft.type,
        serviceIds: draft.serviceIds,
        zoneId: draft.zoneId ?? null,
        barberId: draft.barberId ?? 'any',
        startsAt: draft.startsAt,
        customer: { name: values.name, phone: values.phone, email: values.email },
        address: values.address || undefined,
        landmark: values.landmark || undefined,
        notes: values.notes || undefined,
      });
      // Confirmation is viewable from this session; the manage link works anywhere.
      req.session.confirmed = [...(req.session.confirmed || []), booking.reference].slice(-5);
      req.session.booking = {};
      return res.redirect(`/book/confirmed/${booking.reference}`);
    } catch (err) {
      if (err instanceof SlotTakenError) {
        const date = toShopDate(new Date(draft.startsAt));
        delete draft.startsAt;
        setFlash(req, 'error', 'Sorry, that time was just taken. Here are the latest free times.');
        return res.redirect(`/book/time?date=${date}`);
      }
      if (err instanceof ValidationError) {
        const errors = {};
        for (const d of err.details || []) {
          const key = String(d.path).replace(/^customer\./, '');
          errors[key] = errors[key] || d.message;
        }
        if (!Object.keys(errors).length) errors._form = err.message;
        // Post/Redirect/Get: show the errors on a GET so a refresh never resubmits the form.
        // The typed values are already in draft.customer.
        req.session.formErrors = errors;
        return res.redirect(303, '/book/details');
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------- confirmation
async function bookingView(booking) {
  const settings = await settingsService.getAll();
  return {
    booking,
    when: flow.formatWhen(booking.startsAt),
    day: flow.formatDay(booking.startsAt),
    time: flow.formatTime(booking.startsAt),
    endTime: flow.formatTime(booking.endsAt),
    manageUrl: `${env.APP_URL}/manage/${booking.manageToken}`,
    check: canModify(booking, { now: new Date(), cutoffMin: settings.cancelCutoffMin }),
    cutoffMin: settings.cancelCutoffMin,
  };
}

router.get(
  '/book/confirmed/:reference',
  asyncRoute(async (req, res, next) => {
    const ref = String(req.params.reference).toUpperCase();
    if (!(req.session.confirmed || []).includes(ref))
      return next(new NotFoundError('Booking not found'));
    const booking = await prisma.booking.findUnique({
      where: { reference: ref },
      include: { services: true, barber: true, customer: true, zone: true },
    });
    if (!booking) return next(new NotFoundError('Booking not found'));
    res.render('booking/confirmed', {
      title: 'Booked',
      page: 'book',
      ...(await bookingView(booking)),
    });
  }),
);

// ---------------------------------------------------------------- manage link
const loadByToken = asyncRoute(async (req, res, next) => {
  const booking = await getBookingByToken(req.params.token);
  if (!booking)
    return next(
      new NotFoundError('We couldn’t find that booking. Check the link in your confirmation.'),
    );
  req.managed = booking;
  next();
});

router.get(
  '/manage/:token',
  loadByToken,
  asyncRoute(async (req, res) => {
    res.render('booking/manage', {
      title: `Booking ${req.managed.reference}`,
      page: 'manage',
      flash: takeFlash(req),
      ...(await bookingView(req.managed)),
    });
  }),
);

router.post(
  '/manage/:token/cancel',
  bookingLimiter,
  loadByToken,
  asyncRoute(async (req, res) => {
    try {
      await cancelBooking(req.params.token, { reason: req.body.reason });
      setFlash(req, 'success', 'Your booking has been cancelled. We hope to see you soon.');
    } catch (err) {
      setFlash(req, 'error', err.message);
    }
    res.redirect(`/manage/${req.params.token}`);
  }),
);

router.get(
  '/manage/:token/reschedule',
  loadByToken,
  asyncRoute(async (req, res) => {
    const b = req.managed;
    const settings = await settingsService.getAll();
    const check = canModify(b, { now: new Date(), cutoffMin: settings.cancelCutoffMin });
    if (!check.allowed) {
      setFlash(req, 'error', check.reason);
      return res.redirect(`/manage/${req.params.token}`);
    }
    const ctx = await flow.loadContext({
      type: b.type,
      zoneId: b.zoneId,
      serviceIds: b.services.map((s) => s.serviceId),
    });
    const window = settings.bookingWindowDays;
    let barberId = req.query.barber ?? String(b.barberId);
    barberId = barberId === 'any' ? 'any' : Number(barberId);
    if (barberId !== 'any' && !ctx.barbers.some((x) => x.id === barberId)) barberId = 'any';
    let date = isValidDateStr(req.query.date) ? req.query.date : toShopDate(b.startsAt);
    if (date < ctx.today || date > addDays(ctx.today, window))
      date = flow.firstOpenDate(ctx.today, ctx.openWeekdays, window);

    const slots = await rescheduleSlots(b, { date, barberId });
    res.render('booking/reschedule', {
      title: 'Reschedule',
      page: 'manage',
      flash: takeFlash(req),
      ...(await bookingView(b)),
      ctx,
      date,
      barberId,
      days: flow.dateStrip({ today: ctx.today, days: window, openWeekdays: ctx.openWeekdays }),
      groups: flow.groupSlots(slots.slots),
      slotsError: slots.error,
    });
  }),
);

/** Slots for moving a booking: its own block doesn't count against it. */
async function rescheduleSlots(b, { date, barberId }) {
  const settings = await settingsService.getAll();
  try {
    const { slots } = await computeDay(
      prisma,
      {
        date,
        barberId,
        serviceIds: b.services.map((s) => s.serviceId),
        type: b.type,
        zoneId: b.zoneId,
        excludeBookingId: b.id,
      },
      { now: new Date(), settings },
    );
    return { slots, error: null };
  } catch (err) {
    if (err instanceof ValidationError) return { slots: [], error: err.message };
    throw err;
  }
}

// JSON for the reschedule page's live date switching (token-scoped, rate limited).
router.get(
  '/manage/:token/slots',
  apiLimiter,
  loadByToken,
  asyncRoute(async (req, res) => {
    const date = isValidDateStr(req.query.date) ? req.query.date : null;
    if (!date)
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'Use YYYY-MM-DD' } });
    const barberId =
      req.query.barber && req.query.barber !== 'any' ? Number(req.query.barber) : 'any';
    const { slots, error } = await rescheduleSlots(req.managed, { date, barberId });
    res.set('Cache-Control', 'no-store');
    res.json({ date, slots, error });
  }),
);

router.post(
  '/manage/:token/reschedule',
  bookingLimiter,
  loadByToken,
  asyncRoute(async (req, res) => {
    try {
      await rescheduleBooking(req.params.token, {
        startsAt: req.body.startsAt,
        barberId: req.body.barberId || 'any',
      });
      setFlash(
        req,
        'success',
        req.managed.type === 'HOME'
          ? 'Your visit has been moved. We’ll call to confirm the new time.'
          : 'Your booking has been moved to the new time.',
      );
      res.redirect(`/manage/${req.params.token}`);
    } catch (err) {
      if (err instanceof SlotTakenError || err instanceof ValidationError) {
        setFlash(
          req,
          'error',
          err instanceof SlotTakenError
            ? 'That time was just taken. Please pick another.'
            : err.message,
        );
        return res.redirect(`/manage/${req.params.token}/reschedule`);
      }
      setFlash(req, 'error', err.message);
      res.redirect(`/manage/${req.params.token}`);
    }
  }),
);

router.get(
  '/manage/:token/calendar.ics',
  loadByToken,
  asyncRoute(async (req, res) => {
    const b = req.managed;
    const settings = await settingsService.getAll();
    const shop = settings.shop;
    const ics = buildIcs({
      uid: `${b.reference}@${new URL(env.APP_URL).hostname}`,
      start: b.startsAt,
      end: b.endsAt,
      summary: `${shop.name}: ${b.services.map((s) => s.name).join(', ')}`,
      description: `Booking ${b.reference}. Manage or cancel: ${env.APP_URL}/manage/${b.manageToken}`,
      location: b.type === 'HOME' ? b.address : shop.address.join(', '),
      url: `${env.APP_URL}/manage/${b.manageToken}`,
      cancelled: b.status === 'CANCELLED',
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${b.reference}.ics"`);
    res.send(ics);
  }),
);

module.exports = router;
