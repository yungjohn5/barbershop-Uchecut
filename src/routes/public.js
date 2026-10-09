const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// Placeholder home: proves layout, Tailwind and DB wiring. Full sections come in Phase 3.
router.get('/', async (req, res, next) => {
  try {
    const categories = await prisma.serviceCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        services: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    res.render('pages/home', { title: null, categories });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
