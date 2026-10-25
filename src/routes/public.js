const express = require('express');
const { getHomeContent } = require('../services/content');
const seo = require('../services/seo');

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const content = await getHomeContent();
    res.locals.seo.jsonLd = seo.barberShopJsonLd({
      shop: res.locals.shop,
      hours: content.weeklyHours,
      services: content.services,
      image: res.locals.seo.image.url,
    });
    // Section numbers (01, 02…) in render order, so they stay sequential when a section hides.
    let n = 0;
    res.locals.sec = () => String((n += 1)).padStart(2, '0');
    res.render('pages/home', { title: null, page: 'home', ...content });
  }),
);

module.exports = router;
