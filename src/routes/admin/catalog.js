// Owner sections: services and categories, barbers (profile, hours, time off), zones,
// products and gallery. Mounted behind requireRole('OWNER'); rules live in
// services/catalog.js and services/barbers.js.
const express = require('express');
const prisma = require('../../lib/prisma');
const { NotFoundError } = require('../../lib/errors');
const catalog = require('../../services/catalog');
const barbers = require('../../services/barbers');
const { asyncRoute, setFlash, view, back, idParam, takeForm, formPost } = require('./helpers');
const { formatShort, formatTime } = require('../../lib/viewHelpers');

const router = express.Router();
const dir = (req) => (req.body.dir === 'up' ? 'up' : 'down');
const activeBarbers = () =>
  prisma.barber.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
const list = (rows) =>
  rows
    .map((b) => `${b.reference} (${formatShort(b.startsAt)} ${formatTime(b.startsAt)})`)
    .join(', ');

// ================================================================ services & categories
router.get(
  '/services',
  asyncRoute(async (req, res) => {
    view(req, res, 'services/index', {
      title: 'Services',
      nav: 'services',
      categories: await catalog.listCatalogue(),
      categoryForm: takeForm(req, 'category'),
    });
  }),
);

async function serviceForm(req, res, service) {
  const form = takeForm(req, service ? `service-${service.id}` : 'service-new');
  const [categories, allBarbers] = await Promise.all([
    prisma.serviceCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    activeBarbers(),
  ]);
  const v = form.values || {};
  view(req, res, 'services/form', {
    title: service ? service.name : 'New service',
    nav: 'services',
    service,
    categories,
    barbers: allBarbers,
    errors: form.errors,
    values: form.values
      ? {
          ...v,
          barberIds: [].concat(v.barberIds || []).map(Number),
          homeAvailable: !!v.homeAvailable,
          active: !!v.active,
        }
      : service
        ? {
            name: service.name,
            categoryId: service.categoryId,
            price: catalog.koboToInput(service.priceKobo),
            durationMin: service.durationMin,
            description: service.description || '',
            homeAvailable: service.homeAvailable,
            active: service.active,
            barberIds: service.barbers.map((b) => b.barberId),
          }
        : {
            categoryId: Number(req.query.category) || (categories[0] && categories[0].id),
            durationMin: 30,
            homeAvailable: true,
            active: true,
            barberIds: allBarbers.filter((b) => b.active).map((b) => b.id),
          },
  });
}

router.get(
  '/services/new',
  asyncRoute((req, res) => serviceForm(req, res, null)),
);

router.post(
  '/services',
  formPost('service-new', '/admin/services/new', async (req, res) => {
    const s = await catalog.saveService(null, req.body, { file: req.file });
    setFlash(req, 'success', `${s.name} added.`);
    res.redirect(303, '/admin/services');
  }),
);

router.get(
  '/services/:id',
  asyncRoute(async (req, res, next) => {
    const service = await catalog.getService(idParam(req));
    if (!service) return next(new NotFoundError('Service not found'));
    await serviceForm(req, res, service);
  }),
);

router.post(
  '/services/:id',
  formPost(
    (req) => `service-${idParam(req)}`,
    (req) => `/admin/services/${idParam(req)}`,
    async (req, res) => {
      const s = await catalog.saveService(idParam(req), req.body, { file: req.file });
      setFlash(req, 'success', `${s.name} saved.`);
      res.redirect(303, '/admin/services');
    },
  ),
);

router.post(
  '/services/:id/active',
  formPost('noop', '/admin/services', async (req, res) => {
    const s = await catalog.setActive(idParam(req), req.body.active === 'true');
    setFlash(req, 'success', `${s.name} is ${s.active ? 'live on the site' : 'hidden'}.`);
    res.redirect(303, back(req, '/admin/services'));
  }),
);

router.post(
  '/services/:id/move',
  formPost('noop', '/admin/services', async (req, res) => {
    const s = await prisma.service.findUnique({ where: { id: idParam(req) } });
    if (!s) throw new NotFoundError('Service not found');
    await catalog.move('service', s.id, dir(req), { where: { categoryId: s.categoryId } });
    res.redirect(303, back(req, '/admin/services'));
  }),
);

router.post(
  '/services/:id/delete',
  formPost('noop', '/admin/services', async (req, res) => {
    await catalog.deleteService(idParam(req));
    setFlash(req, 'success', 'Service deleted.');
    res.redirect(303, '/admin/services');
  }),
);

router.post(
  '/categories',
  formPost('category', '/admin/services#categories', async (req, res) => {
    const c = await catalog.saveCategory(null, req.body);
    setFlash(req, 'success', `Category “${c.name}” added.`);
    res.redirect(303, '/admin/services#categories');
  }),
);

router.post(
  '/categories/:id',
  formPost('category', '/admin/services', async (req, res) => {
    const c = await catalog.saveCategory(idParam(req), req.body);
    setFlash(req, 'success', `Renamed to “${c.name}”.`);
    res.redirect(303, '/admin/services');
  }),
);

router.post(
  '/categories/:id/move',
  formPost('noop', '/admin/services', async (req, res) => {
    await catalog.move('serviceCategory', idParam(req), dir(req));
    res.redirect(303, '/admin/services');
  }),
);

router.post(
  '/categories/:id/delete',
  formPost('noop', '/admin/services', async (req, res) => {
    await catalog.deleteCategory(idParam(req));
    setFlash(req, 'success', 'Category deleted.');
    res.redirect(303, '/admin/services');
  }),
);

// ================================================================ barbers
router.get(
  '/barbers',
  asyncRoute(async (req, res) => {
    view(req, res, 'barbers/index', {
      title: 'Barbers',
      nav: 'barbers',
      barbers: await barbers.listBarbers(),
      weekdays: barbers.WEEKDAYS,
    });
  }),
);

async function barberPage(req, res, barber) {
  const profile = takeForm(req, barber ? `barber-${barber.id}` : 'barber-new');
  const hoursForm = takeForm(req, `hours-${barber && barber.id}`);
  const offForm = takeForm(req, `off-${barber && barber.id}`);
  const categories = await catalog.listCatalogue();
  const v = profile.values;
  view(req, res, 'barbers/form', {
    title: barber ? barber.name : 'New barber',
    nav: 'barbers',
    barber,
    categories,
    weekdays: barbers.WEEKDAYS,
    errors: profile.errors,
    values: v
      ? {
          ...v,
          serviceIds: [].concat(v.serviceIds || []).map(Number),
          doesHomeService: !!v.doesHomeService,
          active: !!v.active,
        }
      : barber
        ? {
            name: barber.name,
            bio: barber.bio || '',
            specialties: barber.specialties.join(', '),
            doesHomeService: barber.doesHomeService,
            active: barber.active,
            serviceIds: barber.services.map((s) => s.serviceId),
          }
        : {
            active: true,
            doesHomeService: false,
            serviceIds: categories.flatMap((c) =>
              c.services.filter((s) => s.active).map((s) => s.id),
            ),
          },
    hours: barber
      ? hoursForm.values
        ? Object.fromEntries(
            barbers.WEEKDAYS.map(([d]) => [
              d,
              {
                open: !!hoursForm.values[`open_${d}`],
                start: hoursForm.values[`start_${d}`] || '',
                end: hoursForm.values[`end_${d}`] || '',
              },
            ]),
          )
        : barbers.hoursForForm(barber.hours)
      : null,
    hoursErrors: hoursForm.errors,
    off: offForm.values || { allDay: 'on' },
    offErrors: offForm.errors,
  });
}

router.get(
  '/barbers/new',
  asyncRoute((req, res) => barberPage(req, res, null)),
);

router.post(
  '/barbers',
  formPost('barber-new', '/admin/barbers/new', async (req, res) => {
    const b = await barbers.saveProfile(null, req.body, { file: req.file });
    setFlash(
      req,
      'success',
      `${b.name} added. Set their weekly hours below so customers can book them.`,
    );
    res.redirect(303, `/admin/barbers/${b.id}#hours`);
  }),
);

router.get(
  '/barbers/:id',
  asyncRoute(async (req, res, next) => {
    const barber = await barbers.getBarber(idParam(req));
    if (!barber) return next(new NotFoundError('Barber not found'));
    await barberPage(req, res, barber);
  }),
);

router.post(
  '/barbers/:id',
  formPost(
    (req) => `barber-${idParam(req)}`,
    (req) => `/admin/barbers/${idParam(req)}`,
    async (req, res) => {
      const b = await barbers.saveProfile(idParam(req), req.body, { file: req.file });
      setFlash(req, 'success', `${b.name}’s profile saved.`);
      res.redirect(303, `/admin/barbers/${b.id}`);
    },
  ),
);

router.post(
  '/barbers/:id/hours',
  formPost(
    (req) => `hours-${idParam(req)}`,
    (req) => `/admin/barbers/${idParam(req)}#hours`,
    async (req, res) => {
      const { outside } = await barbers.saveHours(idParam(req), req.body);
      setFlash(
        req,
        outside.length ? 'error' : 'success',
        outside.length
          ? `Hours saved, but ${outside.length} upcoming booking${outside.length > 1 ? 's fall' : ' falls'} outside them: ${list(outside)}. Move or cancel ${outside.length > 1 ? 'them' : 'it'}.`
          : 'Weekly hours saved.',
      );
      res.redirect(303, `/admin/barbers/${idParam(req)}#hours`);
    },
  ),
);

router.post(
  '/barbers/:id/time-off',
  formPost(
    (req) => `off-${idParam(req)}`,
    (req) => `/admin/barbers/${idParam(req)}#time-off`,
    async (req, res) => {
      const { clashes } = await barbers.addTimeOff(idParam(req), req.body);
      setFlash(
        req,
        clashes.length ? 'error' : 'success',
        clashes.length
          ? `Time off added. It overlaps ${clashes.length} booking${clashes.length > 1 ? 's' : ''} that still stand${clashes.length > 1 ? '' : 's'}: ${list(clashes)}.`
          : 'Time off added.',
      );
      res.redirect(303, `/admin/barbers/${idParam(req)}#time-off`);
    },
  ),
);

router.post(
  '/barbers/:id/time-off/:offId/delete',
  formPost(
    'noop',
    (req) => `/admin/barbers/${idParam(req)}#time-off`,
    async (req, res) => {
      await barbers.deleteTimeOff(idParam(req), Number(req.params.offId));
      setFlash(req, 'success', 'Time off removed.');
      res.redirect(303, `/admin/barbers/${idParam(req)}#time-off`);
    },
  ),
);

router.post(
  '/barbers/:id/move',
  formPost('noop', '/admin/barbers', async (req, res) => {
    await catalog.move('barber', idParam(req), dir(req));
    res.redirect(303, '/admin/barbers');
  }),
);

// ================================================================ zones
router.get(
  '/zones',
  asyncRoute(async (req, res) => {
    view(req, res, 'zones/index', {
      title: 'Zones',
      nav: 'zones',
      zones: await catalog.listZones(),
    });
  }),
);

async function zoneForm(req, res, zone) {
  const form = takeForm(req, zone ? `zone-${zone.id}` : 'zone-new');
  view(req, res, 'zones/form', {
    title: zone ? zone.name : 'New zone',
    nav: 'zones',
    zone,
    errors: form.errors,
    values: form.values
      ? { ...form.values, active: !!form.values.active }
      : zone
        ? {
            name: zone.name,
            fee: catalog.koboToInput(zone.feeKobo),
            travelBufferMin: zone.travelBufferMin,
            active: zone.active,
          }
        : { travelBufferMin: 30, active: true },
  });
}

router.get(
  '/zones/new',
  asyncRoute((req, res) => zoneForm(req, res, null)),
);
router.post(
  '/zones',
  formPost('zone-new', '/admin/zones/new', async (req, res) => {
    const z = await catalog.saveZone(null, req.body);
    setFlash(req, 'success', `${z.name} added.`);
    res.redirect(303, '/admin/zones');
  }),
);
router.get(
  '/zones/:id',
  asyncRoute(async (req, res, next) => {
    const zone = await prisma.zone.findUnique({
      where: { id: idParam(req) },
      include: { _count: { select: { bookings: true } } },
    });
    if (!zone) return next(new NotFoundError('Zone not found'));
    await zoneForm(req, res, zone);
  }),
);
router.post(
  '/zones/:id',
  formPost(
    (req) => `zone-${idParam(req)}`,
    (req) => `/admin/zones/${idParam(req)}`,
    async (req, res) => {
      const z = await catalog.saveZone(idParam(req), req.body);
      setFlash(req, 'success', `${z.name} saved.`);
      res.redirect(303, '/admin/zones');
    },
  ),
);
router.post(
  '/zones/:id/move',
  formPost('noop', '/admin/zones', async (req, res) => {
    await catalog.move('zone', idParam(req), dir(req));
    res.redirect(303, '/admin/zones');
  }),
);
router.post(
  '/zones/:id/delete',
  formPost('noop', '/admin/zones', async (req, res) => {
    await catalog.deleteZone(idParam(req));
    setFlash(req, 'success', 'Zone deleted.');
    res.redirect(303, '/admin/zones');
  }),
);

// ================================================================ products
router.get(
  '/products',
  asyncRoute(async (req, res) => {
    view(req, res, 'products/index', {
      title: 'Products',
      nav: 'products',
      products: await catalog.listProducts(),
    });
  }),
);

async function productForm(req, res, product) {
  const form = takeForm(req, product ? `product-${product.id}` : 'product-new');
  view(req, res, 'products/form', {
    title: product ? product.name : 'New product',
    nav: 'products',
    product,
    errors: form.errors,
    values: form.values
      ? { ...form.values, visible: !!form.values.visible }
      : product
        ? {
            name: product.name,
            description: product.description || '',
            price: catalog.koboToInput(product.priceKobo),
            visible: product.visible,
          }
        : { visible: true },
  });
}

router.get(
  '/products/new',
  asyncRoute((req, res) => productForm(req, res, null)),
);
router.post(
  '/products',
  formPost('product-new', '/admin/products/new', async (req, res) => {
    const p = await catalog.saveProduct(null, req.body, { file: req.file });
    setFlash(req, 'success', `${p.name} added.`);
    res.redirect(303, '/admin/products');
  }),
);
router.get(
  '/products/:id',
  asyncRoute(async (req, res, next) => {
    const product = await prisma.product.findUnique({ where: { id: idParam(req) } });
    if (!product) return next(new NotFoundError('Product not found'));
    await productForm(req, res, product);
  }),
);
router.post(
  '/products/:id',
  formPost(
    (req) => `product-${idParam(req)}`,
    (req) => `/admin/products/${idParam(req)}`,
    async (req, res) => {
      const p = await catalog.saveProduct(idParam(req), req.body, { file: req.file });
      setFlash(req, 'success', `${p.name} saved.`);
      res.redirect(303, '/admin/products');
    },
  ),
);
router.post(
  '/products/:id/move',
  formPost('noop', '/admin/products', async (req, res) => {
    await catalog.move('product', idParam(req), dir(req));
    res.redirect(303, '/admin/products');
  }),
);
router.post(
  '/products/:id/delete',
  formPost('noop', '/admin/products', async (req, res) => {
    await catalog.deleteProduct(idParam(req));
    setFlash(req, 'success', 'Product deleted.');
    res.redirect(303, '/admin/products');
  }),
);

// ================================================================ gallery
router.get(
  '/gallery',
  asyncRoute(async (req, res) => {
    const [items, allBarbers] = await Promise.all([catalog.listGallery(), activeBarbers()]);
    view(req, res, 'gallery/index', {
      title: 'Gallery',
      nav: 'gallery',
      items,
      barbers: allBarbers,
      form: takeForm(req, 'gallery-new'),
    });
  }),
);
router.post(
  '/gallery',
  formPost('gallery-new', '/admin/gallery', async (req, res) => {
    await catalog.addGalleryItem(req.body, { file: req.file });
    setFlash(req, 'success', 'Photo added.');
    res.redirect(303, '/admin/gallery');
  }),
);
router.post(
  '/gallery/:id',
  formPost('noop', '/admin/gallery', async (req, res) => {
    await catalog.updateGalleryItem(idParam(req), req.body);
    setFlash(req, 'success', 'Photo updated.');
    res.redirect(303, `/admin/gallery#g-${idParam(req)}`);
  }),
);
router.post(
  '/gallery/:id/move',
  formPost('noop', '/admin/gallery', async (req, res) => {
    await catalog.move('galleryItem', idParam(req), dir(req));
    res.redirect(303, `/admin/gallery#g-${idParam(req)}`);
  }),
);
router.post(
  '/gallery/:id/delete',
  formPost('noop', '/admin/gallery', async (req, res) => {
    await catalog.deleteGalleryItem(idParam(req));
    setFlash(req, 'success', 'Photo deleted.');
    res.redirect(303, '/admin/gallery');
  }),
);

module.exports = router;
