# Barbershop Booking Platform — Architecture Plan

Oct 8, 2026

## Overview

One Node.js/Express app serves an editorial, Victory-style marketing site and a booking engine for in-shop and home-service appointments, with no online payment.

**Goals**

- Showcase the shop: services, styles gallery, barbers, products and contact details.
- Let customers book ahead for an in-shop visit or a home visit, without creating an account.
- Give the owner a dashboard to manage services, barbers, working hours, zones and bookings.

**Decisions locked in**

| Decision | Choice | Why |
| --- | --- | --- |
| Architecture | Single Express app: EJS server-rendered pages + JSON endpoints for the booking widget | One codebase, one deploy, SEO-friendly pages |
| Database | PostgreSQL via Prisma ORM | Relational data, safe migrations, typed queries |
| Payment | None online; customer pays at the shop or on arrival | Client's choice; keeps checkout simple |
| Home service | Customer picks a zone; each zone adds a fixed fee and travel buffer | Predictable pricing and realistic scheduling |
| Customer accounts | Guest booking with phone + email; manage via a secure link | Lowest friction for walk-in style customers |

**Out of scope for v1:** online payments, loyalty points, a mobile app, product e-commerce (products are display-only).

## Tech stack and project structure

Node 22 LTS (`.nvmrc`, `engines >=22`; Node 20 is end-of-life) + Express 4, EJS templates with Tailwind CSS 3, PostgreSQL 17 through Prisma 6, and a little vanilla JS (or Alpine.js) for the booking widget.

| Concern | Package | Notes |
| --- | --- | --- |
| Server | `express`, `helmet`, `compression`, `morgan` | Security headers, gzip, request logs |
| Views | `ejs`, `express-ejs-layouts` | Shared layout, partials per section |
| Styling | `tailwindcss` (CLI build) | Gloock headings, DM Serif Display italic accents, Inter body (Google Fonts) |
| Motion | `gsap` 3.15 (ScrollTrigger, SplitText, Flip) | Added at the client's request. Served from `node_modules` at `/vendor/gsap` so the CSP stays `script-src 'self'`. Everything renders without JS; `prefers-reduced-motion` disables all animation |
| Database | `prisma`, `@prisma/client` | Migrations + seed script |
| Validation | `zod` | One schema per form/endpoint |
| Admin auth | `express-session`, `connect-pg-simple`, `bcrypt` | Sessions stored in Postgres |
| Security | `csrf-sync`, `express-rate-limit` | CSRF on forms, rate limit on booking |
| Dates | `date-fns`, `date-fns-tz` | All times in Africa/Lagos |
| Email/SMS | `nodemailer` (SMTP), Termii API behind `sms.send()` | Confirmations and reminders |
| Jobs | `node-cron` | Reminder sends, expire unconfirmed home requests |
| Uploads | `multer` + `sharp` | Resize gallery/barber photos to WebP |
| Process | `pm2` | Production process manager |
| Dev tooling | `nodemon`, `concurrently`, `eslint`, `prettier`, `jest` | `npm run dev` runs the server and the Tailwind watcher together |

```text
uchecut/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.js
├── src/
│   ├── app.js              # express app, middleware, view engine
│   ├── server.js           # listen + graceful shutdown
│   ├── config/             # env loader, constants (timezone, slot size)
│   ├── lib/                # prisma client, mailer, sms, logger
│   ├── middleware/         # requireAdmin, validate(zod), errorHandler
│   ├── services/
│   │   ├── availability.js # slot generation engine
│   │   ├── booking.js      # create / reschedule / cancel
│   │   └── notify.js       # email + SMS templates
│   ├── routes/
│   │   ├── public.js       # site pages
│   │   ├── booking.js      # booking flow pages
│   │   ├── api.js          # JSON: slots, zones, services
│   │   └── admin/          # dashboard routes
│   ├── views/
│   │   ├── layouts/
│   │   ├── partials/       # nav, footer, service-card, cta
│   │   ├── pages/          # home, services, barbers, products, contact
│   │   ├── booking/        # steps + confirmation
│   │   ├── admin/
│   │   └── emails/
│   └── jobs/               # reminders.js
├── public/                 # built css, js, images
├── tailwind.config.js
├── .env.example
└── package.json
```

Business logic lives in `services/`, so routes stay thin and the availability engine can be unit-tested with Jest without a server.

## Data model

Fifteen Prisma models cover the catalogue, staff schedules, zones, bookings, content and sessions; a booking always belongs to one barber, one customer and one or more services.

| Table | Purpose | Key relations |
| --- | --- | --- |
| `ServiceCategory` | Filter tabs: Cut & Craft, Beard & Grooming, Signature Rituals, Maintenance & Care | has many `Service` |
| `Service` | Name, price (NGN, kobo), duration (min), image, `homeAvailable` flag | many-to-many `Barber` via `BarberService`, via `BookingService` to `Booking` |
| `Barber` | Profile, photo, bio, specialties, active flag, `doesHomeService` | has many `WorkingHours`, `TimeOff`, `Booking` |
| `WorkingHours` | Weekly shift per barber: weekday, start, end | belongs to `Barber` |
| `TimeOff` | Holidays, breaks, blocked ranges | belongs to `Barber` |
| `Zone` | Home-service area: name, fee, travel buffer (min), active | has many `Booking` |
| `Customer` | Name, phone (unique), email, notes, no-show count | has many `Booking` |
| `Booking` | Date/time, type (SHOP/HOME), status, address, totals, manage token | belongs to `Barber`, `Customer`, optional `Zone` |
| `BookingService` | Join table with price/duration snapshot at booking time | `Booking` × `Service` |
| `BarberService` | Explicit join: which services each barber offers | `Barber` × `Service` |
| `Admin` | Dashboard users: email, password hash, role (OWNER/STAFF), lockout fields | — |
| `Session` | `connect-pg-simple` store (table `session`), modelled in Prisma so migrations own it; the store runs with `createTableIfMissing: false` | — |

Gallery images, products and shop settings (hours, address, socials) are three small extra tables (`GalleryItem`, `Product`, `Setting`) edited from the dashboard.

Every `DateTime` column is `@db.Timestamptz(3)` and holds UTC; this also lets the exclusion constraint use `tstzrange` (an immutable expression).

```prisma
enum BookingType   { SHOP HOME }
enum BookingStatus { PENDING CONFIRMED COMPLETED CANCELLED NO_SHOW }

model Service {
  id            Int              @id @default(autoincrement())
  name          String
  slug          String           @unique
  description   String?
  priceKobo     Int              // 750000 = ₦7,500
  durationMin   Int
  homeAvailable Boolean          @default(true)
  imageUrl      String?
  sortOrder     Int              @default(0)
  active        Boolean          @default(true)
  categoryId    Int
  category      ServiceCategory  @relation(fields: [categoryId], references: [id])
  barbers       Barber[]
  bookings      BookingService[]
}

model Barber {
  id              Int            @id @default(autoincrement())
  name            String
  slug            String         @unique
  bio             String?
  photoUrl        String?
  doesHomeService Boolean        @default(false)
  active          Boolean        @default(true)
  services        Service[]
  hours           WorkingHours[]
  timeOff         TimeOff[]
  bookings        Booking[]
}

model WorkingHours {
  id       Int    @id @default(autoincrement())
  barberId Int
  weekday  Int    // 0 = Sunday
  startMin Int    // minutes from midnight, 600 = 10:00
  endMin   Int
  barber   Barber @relation(fields: [barberId], references: [id], onDelete: Cascade)
  @@unique([barberId, weekday, startMin])
}

model Zone {
  id              Int       @id @default(autoincrement())
  name            String    @unique   // e.g. Lekki Phase 1
  feeKobo         Int
  travelBufferMin Int       // added before AND after the visit
  active          Boolean   @default(true)
  bookings        Booking[]
}

model Booking {
  id             Int              @id @default(autoincrement())
  reference      String           @unique   // VB-7K3QX, shown to customer
  type           BookingType
  status         BookingStatus    @default(PENDING)
  startsAt       DateTime         // service start, stored in UTC
  endsAt         DateTime
  blockStartsAt  DateTime         // startsAt - travel buffer (HOME)
  blockEndsAt    DateTime         // endsAt + travel buffer (HOME)
  address        String?
  landmark       String?
  subtotalKobo   Int
  homeFeeKobo    Int              @default(0)
  totalKobo      Int
  notes          String?
  manageToken    String           @unique   // random 32 bytes, for the manage link
  barberId       Int
  customerId     Int
  zoneId         Int?
  barber         Barber           @relation(fields: [barberId], references: [id])
  customer       Customer         @relation(fields: [customerId], references: [id])
  zone           Zone?            @relation(fields: [zoneId], references: [id])
  services       BookingService[]
  createdAt      DateTime         @default(now())
  @@index([barberId, blockStartsAt, blockEndsAt])
}
```

Money is stored as integer kobo to avoid floating-point errors. `BookingService` copies each service's price and duration at booking time, so later price edits never change old bookings.

## Booking and availability logic

A slot is offered only if the barber is on shift, not on time off, and has no overlapping booking once home-visit travel buffers are added on both sides.

**Slot generation** (`services/availability.js`, input: date, barberId or "any", serviceIds, type, zoneId)

1. Sum the selected services' durations: `serviceMin`. Reject HOME requests containing a service with `homeAvailable = false`.
2. For HOME, read the zone's `travelBufferMin`; for SHOP the buffer is 0. The time the barber is busy is `buffer + serviceMin + buffer`.
3. Load the barber's `WorkingHours` for that weekday, `TimeOff` overlapping the date, and bookings with status PENDING or CONFIRMED.
4. Walk the shift in 15-minute steps. A candidate start `s` is valid when `[s − buffer, s + serviceMin + buffer]` fits inside the shift and overlaps no booking's `[blockStartsAt, blockEndsAt]` or time-off range.
5. Drop slots earlier than now + lead time (default 2 hours for SHOP, 24 hours for HOME) and later than the booking window (default 30 days).
6. For "any barber", merge every eligible barber's slots and assign the barber with the fewest bookings that day when the customer confirms.

Travel buffers are allowed to fall outside shop hours for the first and last visit only if the owner enables `allowBufferOutsideShift` in settings; it is off by default.

**Preventing double booking**

Two customers can pick the same slot at the same moment. The create step runs in one Prisma transaction at `Serializable` isolation: it re-checks overlap with a query on `barberId` + `blockStartsAt < newEnd AND blockEndsAt > newStart`, then inserts. On a conflict the customer sees "That time was just taken" and fresh slots. For extra safety, a raw SQL migration adds a `btree_gist` exclusion constraint `Booking_no_overlap` on `("barberId" WITH =, tstzrange("blockStartsAt", "blockEndsAt", '[)') WITH &&)` where status is PENDING or CONFIRMED. Its SQLSTATE `23P01` (read from the Prisma error meta) maps to `SlotTakenError`; Serializable conflicts (`P2034`) are retried up to 3 times with jittered backoff before giving up.

Just before inserting, the transaction takes `pg_advisory_xact_lock(7341, barberId)`, so concurrent inserts for one barber queue instead of waiting on each other inside the GiST index, which deadlocks (40P01). The next attempt in the queue then meets the committed row and fails cleanly as `SlotTakenError`. The integration suite forces this race (every attempt passes the availability check before any inserts) and asserts exactly one booking wins.

**Pricing**

- `subtotal` = sum of service prices; `homeFee` = zone fee for HOME, else 0; `total` = subtotal + homeFee.
- Shown on every step and in the confirmation; paid in cash or transfer on the day.

**Statuses**

- SHOP bookings are CONFIRMED immediately.
- HOME bookings start PENDING until the owner or barber confirms in the dashboard; unconfirmed requests auto-cancel 12 hours before the slot and the customer is notified.
- After the slot, staff mark COMPLETED or NO_SHOW. Customers can cancel or reschedule via their manage link up to a cutoff (default 3 hours before).

A repeat no-show count is kept on `Customer`, so the owner can require a call-back confirmation for repeat offenders, since there is no deposit to protect slots.

## Routes

Pages render with EJS; the booking widget calls three small JSON endpoints, so the flow works without a page reload but each step still has a server-rendered fallback.

**Public pages**

| Method | Path | Renders |
| --- | --- | --- |
| GET | `/` | Home: hero, intro, services preview, barbers, products, footer CTA |
| GET | `/services` | All services with category filter (`?category=beard-grooming`) |
| GET | `/services/:slug` | Service detail + "Book this" |
| GET | `/barbers` | Team grid |
| GET | `/barbers/:slug` | Barber profile, specialties, gallery |
| GET | `/styles` | Gallery of cuts |
| GET | `/products` | Display-only product showcase |
| GET | `/home-service` | How home visits work, zone list with fees |
| GET | `/contact` | Address, hours, map embed, WhatsApp link |

**Booking flow**

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/book` | Step 1: choose SHOP or HOME (+ zone) |
| GET | `/book/services` | Step 2: pick one or more services |
| GET | `/book/time` | Step 3: pick barber (or any) + date + slot |
| GET | `/book/details` | Step 4: name, phone, email, address/landmark for HOME |
| POST | `/book` | Validate (zod), transaction create, redirect |
| GET | `/book/confirmed/:reference` | Confirmation, add-to-calendar (.ics) link |
| GET | `/manage/:token` | View booking, cancel or reschedule |
| POST | `/manage/:token/cancel` | Cancel before cutoff |
| POST | `/manage/:token/reschedule` | Move to a new valid slot |

Wizard state is kept in the session between steps, so a refresh never loses the selection.

**JSON API** (rate limited, used by the widget)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/zones` | Active zones with fee and buffer |
| GET | `/api/services?type=HOME` | Services allowed for that booking type |
| GET | `/api/slots?date=2026-10-20&barber=any&services=3,5&type=HOME&zone=2` | `{ date, slots: [{ time: "10:15", barberIds: [1, 4] }] }` |

**Admin** (behind `requireAdmin`, all under `/admin`)

- `/admin/login`, `/admin/logout`
- `/admin` dashboard, `/admin/bookings` (list, filters, detail, status actions), `/admin/calendar`
- CRUD: `/admin/services`, `/admin/categories`, `/admin/barbers` (+ hours and time off), `/admin/zones`, `/admin/gallery`, `/admin/products`, `/admin/settings`, `/admin/users` (OWNER only)

## Page map from the design

The home page follows the reference's six sections in order, adapted with a home-service section and real booking CTAs; the visual language is reinterpreted, not cloned.

| # | Design section | Our section | Partial | Data source |
| --- | --- | --- | --- | --- |
| 1 | Hero: photo, big serif headline, circular Book button | Hero with "Book in shop" and "Book a home visit" CTAs | `partials/hero.ejs` | `Setting` (headline, image) |
| 2 | Intro collage: "Modern Ritual of Grooming" | About the shop, 3-photo collage | `partials/intro.ejs` | `Setting` |
| 3 | Services grid with filter tabs | Services preview, tabs by category, price + duration on each card | `partials/service-card.ejs` | `ServiceCategory`, `Service` |
| 4 | Barbers / philosophy | Team cards linking to profiles | `partials/barber-card.ejs` | `Barber` |
| — | (new) | Home service: how it works in 3 steps + zone fee list | `partials/home-service.ejs` | `Zone` |
| 5 | Products carousel | Product showcase, no cart | `partials/product-rail.ejs` | `Product` |
| 6 | "Take the Chair" footer | Big image-clipped CTA, hours, address, socials, WhatsApp | `partials/footer.ejs` | `Setting` |

**Implementation notes (home page)**

- Section partials live in `views/partials/home/`; data comes from `services/content.js` (`getHomeContent`), copy from the `home` setting (code defaults in `config/constants.js` until the owner edits it).
- Responsive images follow `${base}-${width}.webp` (e.g. `/images/site/svc-skin-fade-900.webp`); `Service.imageUrl`, `Barber.photoUrl` and `Product.imageUrl` store the base path. Admin uploads (Phase 4) must write the same widths with `sharp`.
- Current photos are Pexels placeholders, listed in `public/images/site/CREDITS.md`.
- Motion: `public/js/boot.js` (pre-paint flags + 2.5 s failsafe), `site.js` (menu, sticky nav, reveals, parallax, rings, fit-text), `home.js` (hero timeline, marquee, Flip service filter, step progress, pinned product rail on desktop).
- Until the booking wizard ships, `/book` renders a holding page with WhatsApp and call links, so no CTA is dead.

**Design system decisions**

- Type: a high-contrast serif for headings (Gloock or DM Serif Display) and Inter for body, minimum 16px body on mobile.
- Palette: off-white `#F4F1EC`, ink `#141414`, warm amber accent `#B8833E` for CTAs and the active filter tab.
- Mobile: hero headline drops to 2.5rem, the collage becomes a stacked pair, the services grid becomes a 2-column grid, and the product rail scrolls horizontally with snap.
- Sticky "Book now" pill on mobile for every page.
- Photography is the design's backbone: plan a shoot of the shop, barbers and 8 to 12 finished cuts before launch.

## Admin dashboard

The owner runs the whole shop from `/admin`: today's schedule first, then everything that feeds the public site.

| Screen | What it does | Role |
| --- | --- | --- |
| Today | Today's bookings per barber, pending home requests count, quick confirm/complete/no-show | OWNER, STAFF |
| Bookings | Filter by date, barber, type, status; detail view; confirm, cancel, reschedule, add notes | OWNER, STAFF |
| Calendar | Week view per barber, colour by SHOP/HOME, blocked buffers shown greyed | OWNER, STAFF |
| New booking | Staff adds walk-ins or phone bookings using the same availability engine | OWNER, STAFF |
| Services & categories | CRUD, reorder, price, duration, home-available toggle, photo upload | OWNER |
| Barbers | Profile, services offered, weekly hours, time off, home-service toggle | OWNER |
| Zones | Name, fee, travel buffer, active toggle | OWNER |
| Gallery & products | Upload, caption, reorder, show/hide | OWNER |
| Customers | History, no-show count, notes, phone search | OWNER, STAFF |
| Settings | Shop hours text, address, socials, lead times, booking window, cancellation cutoff, hero copy | OWNER |
| Reports | Bookings and revenue (expected vs completed) by week, barber, service, zone | OWNER |

Staff accounts can be linked to a `Barber` later, so each barber sees only their own schedule; that is a v1.1 toggle, not a v1 requirement.

## Notifications, security and deployment

Without a deposit, reminders are the main defence against no-shows, so every booking triggers a confirmation and a reminder on two channels.

**Notifications**

| Trigger | Customer | Shop |
| --- | --- | --- |
| Booking created (SHOP) | Email + SMS: confirmed, reference, manage link | Email to owner |
| Home request created | Email + SMS: request received, awaiting confirmation | Email + SMS to owner |
| Home request confirmed | Email + SMS: confirmed, barber name, arrival window | — |
| Reminder (24 h and 2 h before) | SMS, plus email at 24 h | — |
| Cancelled / rescheduled | Email + SMS | Email to owner |
| Auto-cancel of unconfirmed home request | Email + SMS with rebook link | Email to owner |

SMS goes through Termii (good Nigerian delivery rates) behind a small `sms.send()` wrapper, so the provider can be swapped. A `wa.me` WhatsApp link sits on the confirmation page for quick contact; WhatsApp Business API messaging can come later.

**Security**

- `helmet` headers, HTTPS only, `secure` + `httpOnly` + `sameSite=lax` session cookies.
- CSRF tokens on every form; `express-rate-limit` on `/book`, `/api/slots` and `/admin/login`.
- zod validation on every input; Nigerian phone numbers normalised to `+234…`.
- Admin passwords hashed with bcrypt (cost 12); login lockout after 5 failed attempts.
- Manage links use 32-byte random tokens; references are short and non-sequential.
- Customer addresses visible only to admins; production database backups daily.

**Deployment (DigitalOcean)**

1. Ubuntu 24.04 droplet (2 GB RAM is enough for v1) or App Platform if you prefer managed.
2. Managed PostgreSQL, or Postgres on the droplet with daily `pg_dump` to Spaces.
3. Nginx reverse proxy + Let's Encrypt (certbot); PM2 runs `src/server.js` in cluster mode.
4. Images on DigitalOcean Spaces + CDN, uploaded through `multer` and resized with `sharp`.
5. GitHub Actions: lint + Jest on push; on `main`, SSH deploy → `npm ci` → `prisma migrate deploy` → `pm2 reload`.
6. Env vars: `DATABASE_URL`, `SESSION_SECRET`, `SMTP_*`, `TERMII_API_KEY`, `APP_URL`, `TZ=Africa/Lagos`.

## Build phases and open questions

Build runs in five phases, each ending in something the client can click; the availability engine comes before any UI polish because everything depends on it.

1. **Foundation:** repo, Express app, Prisma schema + migrations, seed data (categories, services, 2 barbers, 4 zones), layout + Tailwind setup.
2. **Booking engine:** `availability.js` with Jest tests (shift edges, buffers, overlaps, time off, "any barber"), transactional create, the `/api/slots` endpoint.
3. **Public site + booking flow:** the six home sections, service/barber/contact pages, 4-step booking wizard, confirmation and manage link.
4. **Admin dashboard:** login, today view, bookings, calendar, CRUD screens, settings, home-request confirmation.
5. **Notifications + launch:** email/SMS templates, reminder cron, auto-cancel job, security pass, DigitalOcean deploy, real content and photos.

**Open questions for the client**

- [ ] Shop name, logo, address and real opening hours?
- [ ] Full service list with prices and durations, and which are available for home visits?
- [ ] Number of barbers, their weekly hours, and which ones do home visits?
- [ ] Home-service zones (e.g. Lekki, Ikoyi, VI, Ajah, Ikeja, Yaba): fee and travel time per zone?
- [ ] Should home visits need manual confirmation (current plan) or auto-confirm like shop bookings?
- [ ] Lead time, cancellation cutoff and how far ahead customers can book?
- [ ] SMS budget and sender ID (Termii needs a registered sender name)?
- [ ] Domain, and who supplies the photography?
