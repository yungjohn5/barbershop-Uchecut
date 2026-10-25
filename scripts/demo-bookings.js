// DEMO bookings for scripts/seed-demo.js: made-up Nigerian customers with fake numbers
// (0803 000 00xx), ~6 weeks of history for reports, today's schedule and the coming week.
// Deterministic (seeded random), only inside opening hours, never overlapping per barber.
// Never used in production (seed-demo refuses to run there).
const { generateReference, generateManageToken } = require('../src/lib/ids');
const { toShopDate, addDays, wallClockToUtc } = require('../src/lib/time');

const CUSTOMERS = [
  'Chinedu Okafor',
  'Tobi Adeyemi',
  'Ifeanyi Nwosu',
  'Seun Balogun',
  'Kelechi Eze',
  'Bayo Ogunleye',
  'Uche Obi',
  'Femi Adebayo',
  'Damilola Akinola',
  'Obinna Chukwu',
  'Ahmed Bello',
  'Musa Ibrahim',
  'Segun Ajayi',
  'Chidi Okeke',
  'Kunle Afolabi',
  'Yusuf Abubakar',
  'Nnamdi Okonkwo',
  'Dayo Oladipo',
  'Ikenna Onyeka',
  'Wale Adeniyi',
  'Sola Ogundipe',
  'Kayode Bankole',
  'Ebuka Nwachukwu',
  'Chuka Umeh',
];
// 0803 000 0001 … 0803 000 0024, stored normalised. Never a real customer's number.
const phoneFor = (i) => `+2348030000${String(i + 1).padStart(3, '0')}`;

const STREETS = [
  'Admiralty Way, Lekki Phase 1',
  'Ozumba Mbadiwe Avenue, Victoria Island',
  'Allen Avenue, Ikeja',
  'Herbert Macaulay Way, Yaba',
  'Adeola Odeku Street, Victoria Island',
  'Freedom Way, Lekki Phase 1',
];
const LANDMARKS = [
  'Opposite the filling station',
  'Blue gate, estate entrance',
  'Beside the pharmacy',
  '',
];
const NOTES = ['First time here', 'Low fade, please', 'Running 5 minutes late maybe', '', '', ''];

/** Small seeded PRNG (mulberry32) so every demo run looks the same. */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * services: [{ id, name, priceKobo, durationMin, homeAvailable }]
 * barbers:  [{ id, doesHomeService, hours: [{ weekday, startMin, endMin }] }]
 * zones:    [{ id, feeKobo, travelBufferMin }]
 */
async function seedDemoBookings(prisma, { services, barbers, zones, now = new Date() }) {
  const rand = rng(20261024);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const customers = [];
  for (const [i, name] of CUSTOMERS.entries()) {
    const first = name.split(' ')[0].toLowerCase();
    customers.push(
      await prisma.customer.create({
        data: {
          name,
          phone: phoneFor(i),
          email: rand() < 0.6 ? `${first}@example.com` : null,
        },
      }),
    );
  }

  const today = toShopDate(now);
  const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
  const nowMs = now.getTime();
  let created = 0;

  // Days -42 … +6: busier in the past (history), lighter ahead (free slots for the demo).
  for (let offset = -42; offset <= 6; offset += 1) {
    const date = addDays(today, offset);
    for (const barber of barbers) {
      const shifts = barber.hours.filter((h) => h.weekday === weekday(date));
      for (const shift of shifts) {
        const target =
          offset < 0 ? 3 + Math.floor(rand() * 4) : offset === 0 ? 4 : 1 + Math.floor(rand() * 2);
        let cursor = shift.startMin + 15 * Math.floor(rand() * 4);
        for (let n = 0; n < target; n += 1) {
          const home = barber.doesHomeService && zones.length && rand() < 0.3;
          const pool = services.filter((s) => (home ? s.homeAvailable : true));
          const chosen = [pick(pool)];
          if (rand() < 0.35) {
            const extra = pick(pool);
            if (extra.id !== chosen[0].id) chosen.push(extra);
          }
          const duration = chosen.reduce((m, s) => m + s.durationMin, 0);
          const zone = home ? pick(zones) : null;
          const buffer = zone ? zone.travelBufferMin : 0;

          const startMin = cursor + buffer;
          const endMin = startMin + duration;
          if (endMin + buffer > shift.endMin) break;
          cursor = endMin + buffer + 15 * (1 + Math.floor(rand() * 4)); // gap before the next

          const startsAt = wallClockToUtc(date, startMin);
          const endsAt = wallClockToUtc(date, endMin);
          const past = endsAt.getTime() < nowMs;
          // Upcoming shop bookings are confirmed; upcoming home visits too (no seeded
          // pending requests, so the demo's own request is the one on the dashboard).
          let status = 'CONFIRMED';
          if (past) {
            const r = rand();
            status = r < 0.86 ? 'COMPLETED' : r < 0.94 ? 'CANCELLED' : 'NO_SHOW';
          }
          const subtotal = chosen.reduce((m, s) => m + s.priceKobo, 0);
          const fee = zone ? zone.feeKobo : 0;
          const customer = pick(customers);
          const createdAt = new Date(startsAt.getTime() - (1 + Math.floor(rand() * 6)) * 86400000);

          await prisma.booking.create({
            data: {
              reference: generateReference(),
              manageToken: generateManageToken(),
              type: home ? 'HOME' : 'SHOP',
              status,
              startsAt,
              endsAt,
              blockStartsAt: new Date(startsAt.getTime() - buffer * 60000),
              blockEndsAt: new Date(endsAt.getTime() + buffer * 60000),
              address: home ? `${10 + Math.floor(rand() * 80)} ${pick(STREETS)}` : null,
              landmark: home ? pick(LANDMARKS) || null : null,
              subtotalKobo: subtotal,
              homeFeeKobo: fee,
              totalKobo: subtotal + fee,
              notes: pick(NOTES) || null,
              source: rand() < 0.8 ? 'WEB' : 'STAFF',
              barberId: barber.id,
              customerId: customer.id,
              zoneId: zone ? zone.id : null,
              confirmedAt: status === 'CANCELLED' ? null : createdAt,
              cancelledAt: status === 'CANCELLED' ? new Date(startsAt.getTime() - 86400000) : null,
              cancelReason: status === 'CANCELLED' ? 'Customer cancelled' : null,
              createdAt,
              services: {
                create: chosen.map((s) => ({
                  serviceId: s.id,
                  name: s.name,
                  priceKobo: s.priceKobo,
                  durationMin: s.durationMin,
                })),
              },
              events: { create: [{ type: 'CREATED', actor: 'CUSTOMER', createdAt }] },
            },
          });
          created += 1;
        }
      }
    }
  }
  return { customers: customers.length, bookings: created };
}

module.exports = { seedDemoBookings, CUSTOMERS, phoneFor };
