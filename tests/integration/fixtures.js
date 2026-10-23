const prisma = require('../../src/lib/prisma');

const TABLES = [
  'Notification',
  'BookingEvent',
  'BookingService',
  'Booking',
  'Customer',
  'TimeOff',
  'WorkingHours',
  'BarberService',
  'Barber',
  'Service',
  'ServiceCategory',
  'Zone',
  'Setting',
  'Product',
  'GalleryItem',
];

async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  require('../../src/services/settings').invalidate();
}

/**
 * Two barbers working 10:00–20:00 every day; barber 1 does home visits.
 * Services: cut (30 min, home ok) and shave (30 min, shop only). One zone with a 30-min buffer.
 */
async function seedFixtures() {
  const category = await prisma.serviceCategory.create({ data: { name: 'Cuts', slug: 'cuts' } });
  const cut = await prisma.service.create({
    data: {
      name: 'Cut',
      slug: 'cut',
      priceKobo: 750000,
      durationMin: 30,
      homeAvailable: true,
      categoryId: category.id,
    },
  });
  const shave = await prisma.service.create({
    data: {
      name: 'Shave',
      slug: 'shave',
      priceKobo: 600000,
      durationMin: 30,
      homeAvailable: false,
      categoryId: category.id,
    },
  });
  const hours = {
    create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 600, endMin: 1200 })),
  };
  const services = { create: [{ serviceId: cut.id }, { serviceId: shave.id }] };
  const homeBarber = await prisma.barber.create({
    data: { name: 'Home Barber', slug: 'home-barber', doesHomeService: true, hours, services },
  });
  const shopBarber = await prisma.barber.create({
    data: { name: 'Shop Barber', slug: 'shop-barber', doesHomeService: false, hours, services },
  });
  const zone = await prisma.zone.create({
    data: { name: 'Lekki', feeKobo: 300000, travelBufferMin: 30 },
  });
  return { cut, shave, homeBarber, shopBarber, zone };
}

module.exports = { prisma, resetDb, seedFixtures };
