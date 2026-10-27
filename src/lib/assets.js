// Fingerprinted asset URLs: asset('/css/app.css') → '/css/app.css?v=3f9c1a2b' (content hash).
// Fingerprinted requests are cached for a year as immutable; a deploy changes the hash, so
// browsers fetch the new file at once. In production hashes are computed once per file; in
// development every call re-reads, so CSS/JS edits show without a restart.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const GSAP_DIR = path.join(__dirname, '..', '..', 'node_modules', 'gsap', 'dist');
const ONE_YEAR = 'public, max-age=31536000, immutable';

const cache = new Map();

function fileFor(urlPath) {
  if (urlPath.startsWith('/vendor/gsap/'))
    return path.join(GSAP_DIR, urlPath.slice('/vendor/gsap/'.length));
  return path.join(PUBLIC_DIR, urlPath);
}

function hashOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
}

function createAsset({ memo = true } = {}) {
  return function asset(urlPath) {
    if (memo && cache.has(urlPath)) return cache.get(urlPath);
    let url = urlPath;
    try {
      url = `${urlPath}?v=${hashOf(fileFor(urlPath))}`;
    } catch {
      // missing file: plain URL, normal caching
    }
    if (memo) cache.set(urlPath, url);
    return url;
  };
}

// Photos, videos, icons and fonts aren't fingerprinted but rarely change in place (a new site
// photo is a new upload): cache them for 30 days in every environment.
const THIRTY_DAYS = 'public, max-age=2592000';
const LONG_LIVED = /^\/(images|media|icons|fonts)\//;

/**
 * express.static setHeaders: a year + immutable for fingerprinted URLs (?v=…), 30 days for
 * photos/icons/fonts, else `fallback`.
 */
function cacheHeaders(fallback) {
  return (res) => {
    const req = res.req || {};
    const v = req.query && req.query.v;
    const p = (req.originalUrl || '').split('?')[0];
    res.setHeader('Cache-Control', v ? ONE_YEAR : LONG_LIVED.test(p) ? THIRTY_DAYS : fallback);
  };
}

module.exports = { createAsset, cacheHeaders, hashOf, ONE_YEAR, THIRTY_DAYS };
