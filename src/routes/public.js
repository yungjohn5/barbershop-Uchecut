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

module.exports = router;
