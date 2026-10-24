// robots.txt, sitemap.xml and the web manifest. Mounted before sessions: no cookies.
const express = require('express');
const settingsService = require('../services/settings');
const seo = require('../services/seo');

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.robotsTxt());
});

router.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(seo.sitemapXml());
});

router.get(
  '/site.webmanifest',
  asyncRoute(async (_req, res) => {
    const shop = await settingsService.get('shop');
    res
      .type('application/manifest+json')
      .set('Cache-Control', 'public, max-age=3600')
      .send(JSON.stringify(seo.webManifest(shop)));
  }),
);

module.exports = router;
