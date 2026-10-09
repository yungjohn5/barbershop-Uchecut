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
    socials: { instagram: '', tiktok: '', x: '', youtube: '' },
  },
};

module.exports = { TIMEZONE, ACTIVE_STATUSES, DEFAULT_SETTINGS };
