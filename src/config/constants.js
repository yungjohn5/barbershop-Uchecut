const TIMEZONE = 'Africa/Lagos';

// Statuses that hold a barber's time (mirrors the Booking_no_overlap constraint).
const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'];

// Defaults for the Setting table. Values in the DB override these; see services/settings.js.
const DEFAULT_SETTINGS = {
  leadTimeShopMin: 120,
  leadTimeHomeMin: 1440,
  bookingWindowDays: 30,
  cancelCutoffMin: 180,
  homeAutoCancelHours: 12,
  allowBufferOutsideShift: false,
  slotStepMin: 15,
  shop: {
    name: 'Victory Barbershop',
    tagline: 'Sharp lines. Quiet confidence. Timeless craft.',
    address: ['Placeholder address', 'Lagos, Nigeria'],
    phone: '+2348000000000',
    whatsapp: '2348000000000',
    email: 'hello@example.com',
    hoursText: ['Mon–Fri · 10:00 – 20:00', 'Sat · 10:00 – 18:00', 'Sun · Closed'],
    // Map pin for search results (JSON-LD geo); null until the owner pastes one in Settings.
    lat: null,
    lng: null,
    socials: { instagram: '', tiktok: '', x: '', youtube: '' },
    // Cyberninja Innovations promo section (home page) and footer credit; owner can switch off.
    showBuilderSection: true,
    showBuilderCredit: true,
  },
  // Site photo slots (Settings → Site photos): { [slot]: { publicId, version, width, height } }.
  // Empty slots show the bundled placeholder (lib/images.js SITE_SLOTS).
  siteImages: {},
  // Home page copy (editable from the dashboard in Phase 4). Placeholder text until the client signs off.
  home: {
    heroLines: ['Sharp Lines.', 'Quiet Confidence.', 'Timeless Craft.'],
    heroText:
      'A Lagos grooming house built on precision. Clean lines, considered details, and a calm room where the craft speaks louder than the noise.',
    introTitle: 'The Modern *Ritual* of Grooming',
    introText:
      'The barbershop has always been where Lagos men talk, trust and transform. We keep that ritual (a proper consultation, an unhurried cut, a hot-towel finish) and bring it up to date with modern technique and a room that respects your time.',
    servicesTitle: 'We Provide A *Variety* Of Services',
    servicesText:
      'Every service starts with a short consultation. Prices are fixed and shown upfront, and you pay on the day, in the shop or when we arrive.',
    craftTitle: 'We Don’t Follow Trends Blindly. We Adapt Them, *Carefully*.',
    craftText:
      'Our barbers are trained professionals with a deep respect for the discipline. Each brings their own eye; all work to one standard: quality without compromise.',
    craftNote: 'Book ahead and your chair is ready when you walk in. No waiting on the bench.',
    homeTitle: 'The Chair *Comes* To You.',
    barbersTitle: 'The Hands Behind *The Cut*.',
    homeText:
      'Busy week? We bring the full kit to your home or office across Lagos. Pick your area, choose a service and time, and we confirm before we set off.',
    productsTitle: 'Only What *Works*',
    productsText:
      'We use and stock a short list of grooming products, chosen for performance, not hype. Everything here is available in the shop; ask your barber what suits your hair.',
    footerText: 'Book your session. Step into a room where time slows down and details matter.',
  },
};

module.exports = { TIMEZONE, ACTIVE_STATUSES, DEFAULT_SETTINGS };
