const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { apiLimiter } = require('../middleware/rateLimits');
const { validate } = require('../middleware/validate');
const { isValidDateStr } = require('../lib/time');
const { getSlots } = require('../services/availability');

const router = express.Router();
router.use(apiLimiter);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const typeSchema = z.enum(['SHOP', 'HOME']);

router.get(
  '/zones',
  asyncRoute(async (_req, res) => {
    const zones = await prisma.zone.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, feeKobo: true, travelBufferMin: true },
    });
    // Revalidate every time (ETag → 304), so a zone or service switched off disappears at once.
    res.set('Cache-Control', 'no-cache');
    res.json({ zones });
  }),
);

router.get(
  '/services',
  validate({ query: z.object({ type: typeSchema.optional() }) }),
  asyncRoute(async (req, res) => {
    const { type } = req.valid.query;
    const services = await prisma.service.findMany({
      where: { active: true, ...(type === 'HOME' ? { homeAvailable: true } : {}) },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        priceKobo: true,
        durationMin: true,
        homeAvailable: true,
        category: { select: { id: true, name: true, slug: true } },
      },
    });
    // Revalidate every time (ETag → 304), so a zone or service switched off disappears at once.
    res.set('Cache-Control', 'no-cache');
    res.json({ services });
  }),
);

const slotsQuery = z.object({
  date: z.string().refine(isValidDateStr, 'Use YYYY-MM-DD'),
  barber: z.union([z.literal('any'), z.coerce.number().int().positive()]).default('any'),
  services: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'Comma-separated service ids')
    .transform((s) => [...new Set(s.split(',').map(Number))])
    .refine((ids) => ids.length <= 10, 'Too many services'),
  type: typeSchema.default('SHOP'),
  zone: z.coerce.number().int().positive().optional(),
});

router.get(
  '/slots',
  validate({ query: slotsQuery }),
  asyncRoute(async (req, res) => {
    const q = req.valid.query;
    const result = await getSlots({
      date: q.date,
      barberId: q.barber,
      serviceIds: q.services,
      type: q.type,
      zoneId: q.zone ?? null,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  }),
);

module.exports = router;
