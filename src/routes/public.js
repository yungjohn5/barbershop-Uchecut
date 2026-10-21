const express = require('express');
const { getHomeContent } = require('../services/content');

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const content = await getHomeContent();
    res.render('pages/home', { title: null, page: 'home', ...content });
  }),
);

// Temporary until the booking wizard lands (Phase 3): keeps every "Book" CTA working.
router.get('/book', (req, res) => {
  const type = req.query.type === 'HOME' ? 'HOME' : 'SHOP';
  res.render('pages/book-soon', { title: 'Book', page: 'book', type });
});

module.exports = router;
