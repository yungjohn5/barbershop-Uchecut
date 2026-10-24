// Search and sharing: canonical URLs from APP_URL, Open Graph/Twitter image, BarberShop
// JSON-LD from Settings + barbers' hours, robots.txt, sitemap.xml and the web manifest.
// Everything here is pure except `middleware`, which fills res.locals.seo for the layout.
const env = require('../config/env');
const { imageUrl, siteImage } = require('../lib/images');

// Pages never meant for search results (also disallowed in robots.txt).
const PRIVATE_PREFIXES = ['/admin', '/manage', '/book/confirmed'];
// Public pages listed in the sitemap.
const SITEMAP_PATHS = ['/', '/book'];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OG_FALLBACK = '/images/og-default.jpg'; // 1200×630 crop of the bundled hero

const base = (appUrl = env.APP_URL) => appUrl.replace(/\/+$/, '');

/** Absolute URL on the public site; query strings are dropped for canonicals. */
function absoluteUrl(pathname = '/', appUrl) {
  if (/^https?:\/\//.test(pathname)) return pathname;
  const p = String(pathname).split(/[?#]/)[0] || '/';
  return `${base(appUrl)}${p.startsWith('/') ? p : `/${p}`}`;
}

const isPrivatePath = (p) =>
  PRIVATE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

/**
 * Share image: the hero photo cropped to 1200×630 by Cloudinary (JPEG for crawlers), or the
 * bundled 1200×630 fallback while the hero is still the placeholder.
 */
function ogImage(siteImages, appUrl) {
  const hero = siteImage('hero', siteImages);
  const url = hero.publicId && imageUrl(hero, { w: 1200, h: 630, format: 'jpg' });
  return { url: url || absoluteUrl(OG_FALLBACK, appUrl), width: 1200, height: 630 };
}

const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Union of barbers' shifts → schema.org OpeningHoursSpecification, days with equal hours grouped. */
function openingHours(hours) {
  const byTime = new Map();
  for (let day = 0; day < 7; day += 1) {
    const shifts = hours.filter((h) => h.weekday === day);
    if (!shifts.length) continue;
    const opens = hhmm(Math.min(...shifts.map((h) => h.startMin)));
    const closes = hhmm(Math.max(...shifts.map((h) => h.endMin)));
    const key = `${opens}-${closes}`;
    if (!byTime.has(key)) byTime.set(key, { opens, closes, days: [] });
    byTime.get(key).days.push(DAYS[day]);
  }
  return [...byTime.values()].map((g) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: g.days,
    opens: g.opens,
    closes: g.closes,
  }));
}

const naira = (kobo) => `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;

/** schema.org BarberShop for the home page, built only from Settings and live data. */
function barberShopJsonLd({ shop, hours = [], services = [], image, appUrl }) {
  const url = absoluteUrl('/', appUrl);
  const lines = shop.address || [];
  const prices = services.map((s) => s.priceKobo).filter((n) => Number.isFinite(n));
  const socials = Object.values(shop.socials || {}).filter(Boolean);
  const geo =
    Number.isFinite(shop.lat) && Number.isFinite(shop.lng)
      ? { '@type': 'GeoCoordinates', latitude: shop.lat, longitude: shop.lng }
      : null;

  const data = {
    '@context': 'https://schema.org',
    '@type': 'BarberShop',
    '@id': `${url}#shop`,
    name: shop.name,
    description: shop.tagline,
    url,
    image: image ? [image] : undefined,
    logo: absoluteUrl('/icons/icon-512.png', appUrl),
    telephone: shop.phone,
    email: shop.email,
    address: lines.length
      ? {
          '@type': 'PostalAddress',
          streetAddress: lines.slice(0, Math.max(1, lines.length - 1)).join(', '),
          addressLocality: 'Lagos',
          addressRegion: 'Lagos',
          addressCountry: 'NG',
        }
      : undefined,
    geo: geo || undefined,
    hasMap: geo ? `https://www.google.com/maps?q=${shop.lat},${shop.lng}` : undefined,
    openingHoursSpecification: hours.length ? openingHours(hours) : undefined,
    priceRange: prices.length
      ? `${naira(Math.min(...prices))}–${naira(Math.max(...prices))}`
      : undefined,
    currenciesAccepted: 'NGN',
    sameAs: socials.length ? socials : undefined,
    potentialAction: {
      '@type': 'ReserveAction',
      target: absoluteUrl('/book', appUrl),
      name: 'Book an appointment',
    },
  };
  return JSON.parse(JSON.stringify(data)); // drop undefined keys
}

// U+2028/U+2029 are valid in JSON but end lines in older JS parsers; escape them too.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** JSON for a <script type="application/ld+json"> block; `<` escaped so text can't close it. */
function jsonLdScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .split(LINE_SEP)
    .join('\\u2028')
    .split(PARA_SEP)
    .join('\\u2029');
}

function robotsTxt(appUrl) {
  return [
    'User-agent: *',
    ...PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`),
    'Disallow: /api/',
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml', appUrl)}`,
    '',
  ].join('\n');
}

const xmlEscape = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );

function sitemapXml({ appUrl, lastmod } = {}) {
  const day = (lastmod || new Date()).toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map(
    (p) =>
      `  <url><loc>${xmlEscape(absoluteUrl(p, appUrl))}</loc><lastmod>${day}</lastmod>` +
      `<priority>${p === '/' ? '1.0' : '0.8'}</priority></url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

function webManifest(shop) {
  return {
    name: shop.name,
    short_name: shop.name.split(' ')[0].slice(0, 12),
    description: shop.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F4F1EC',
    theme_color: '#141414',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

/** Fills res.locals.seo (canonical, robots, share image) for every page; layouts read it. */
function middleware(getSiteImages) {
  return async (req, res, next) => {
    try {
      const noindex = isPrivatePath(req.path);
      if (noindex) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.locals.seo = {
        canonical: absoluteUrl(req.path),
        noindex,
        image: ogImage(await getSiteImages()),
        jsonLd: null, // the home route adds the BarberShop block
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  absoluteUrl,
  isPrivatePath,
  ogImage,
  openingHours,
  barberShopJsonLd,
  jsonLdScript,
  robotsTxt,
  sitemapXml,
  webManifest,
  middleware,
  PRIVATE_PREFIXES,
  SITEMAP_PATHS,
};
