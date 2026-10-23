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
| Motion | `gsap` 3.15 (ScrollTrigger, SplitText, Flip, ScrollSmoother) | Added at the client's request. Served from `node_modules` at `/vendor/gsap` so the CSP stays `script-src 'self'`. Everything renders without JS; `prefers-reduced-motion` disables all animation |
| Database | `prisma`, `@prisma/client` | Migrations + seed script |
| Validation | `zod` | One schema per form/endpoint |
| Admin auth | `express-session`, `connect-pg-simple`, `bcrypt` | Sessions stored in Postgres |
| Security | `csrf-sync`, `express-rate-limit` | CSRF on forms, rate limit on booking |
| Dates | `date-fns`, `date-fns-tz` | All times in Africa/Lagos |
| Email/SMS | `nodemailer` (SMTP), Termii API behind `sms.send()` | Sent from an outbox table by the worker; `NOTIFY_MODE=log` in dev/test never calls a provider |
| Jobs | `node-cron` in a separate worker process | Outbox sends, reminders, auto-cancel, cleanup; each job also holds a Postgres advisory lock |
| Images | `multer` (memory) + Cloudinary | Uploads checked by magic bytes (JPEG/PNG/WebP, 8 MB), stored on Cloudinary; the DB keeps `publicId`/version/size and views build `f_auto,q_auto` URLs |
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

Sixteen Prisma models cover the catalogue, staff schedules, zones, bookings and their history, content and sessions; a booking always belongs to one barber, one customer and one or more services.

| Table | Purpose | Key relations |
| --- | --- | --- |
| `ServiceCategory` | Filter tabs: Cut & Craft, Beard & Grooming, Signature Rituals, Maintenance & Care | has many `Service` |
| `Service` | Name, price (NGN, kobo), duration (min), image, `homeAvailable` flag | many-to-many `Barber` via `BarberService`, via `BookingService` to `Booking` |
| `Barber` | Profile, photo, bio, specialties, active flag, `doesHomeService` | has many `WorkingHours`, `TimeOff`, `Booking` |
| `WorkingHours` | Weekly shift per barber: weekday, start, end | belongs to `Barber` |
| `TimeOff` | Holidays, breaks, blocked ranges | belongs to `Barber` |
| `Zone` | Home-service area: name, fee, travel buffer (min), active | has many `Booking` |
| `Customer` | Name, phone (unique), email, notes, no-show count | has many `Booking` |
| `Booking` | Date/time, type (SHOP/HOME), status, address, totals, manage token, `source` (WEB/STAFF), `staffNotes` (admin only) | belongs to `Barber`, `Customer`, optional `Zone` |
| `BookingService` | Join table with price/duration snapshot at booking time | `Booking` × `Service` |
| `BookingEvent` | Booking history: CREATED, CONFIRMED, RESCHEDULED (from/to, barbers), CANCELLED, COMPLETED, NO_SHOW, RESTORED; actor CUSTOMER/STAFF/SYSTEM and the staff member's name | belongs to `Booking` (cascade) |
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
| POST | `/book/type`, `/book/services`, `/book/time` | Save each step to the session draft, then redirect to the next step |
| GET | `/book/confirmed/:reference` | Confirmation; viewable only from the session that booked it (references are short), with links to the calendar file and manage link |
| GET | `/manage/:token` | View booking, cancel or reschedule |
| POST | `/manage/:token/cancel` | Cancel before cutoff |
| POST | `/manage/:token/reschedule` | Move to a new valid slot (same services and price; home visits return to PENDING) |
| GET | `/manage/:token/reschedule` | Time picker for a new slot, ignoring the booking's own block |
| GET | `/manage/:token/slots` | JSON slots for the reschedule picker (token-scoped, rate limited) |
| GET | `/manage/:token/calendar.ics` | Calendar file (RFC 5545) with a 2-hour reminder |

Wizard state is kept in the session between steps, so a refresh never loses the selection. Each step is a plain form, so the flow works without JavaScript; `public/js/booking.js` adds live totals, in-place slot loading and the mobile summary sheet. Deep links prefill the draft (`/book?type=HOME`, `?service=3`, `?barber=2`). Steps are guarded: a later step redirects to the first incomplete one. Rescheduling uses the same transaction, advisory lock and retry policy as creation.

**JSON API** (rate limited, used by the widget)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/zones` | Active zones with fee and buffer |
| GET | `/api/services?type=HOME` | Services allowed for that booking type |
| GET | `/api/slots?date=2026-10-20&barber=any&services=3,5&type=HOME&zone=2` | `{ date, slots: [{ time: "10:15", barberIds: [1, 4] }] }` |

**Admin** (behind `requireAdmin`, all under `/admin`)

- `/admin/login`, `/admin/logout`
- `/admin` Today; `/admin/bookings` (list with scope chips, search and filters), `/admin/bookings/new` (staff booking), `/admin/bookings/:id` (detail), `POST /admin/bookings/:id/status` (`confirm | complete | noShow | cancel | undo`), `POST /admin/bookings/:id/notes`, `/admin/bookings/:id/reschedule`, `/admin/calendar?date=&barber=`
- Admin JSON: `GET /admin/api/slots` (staff rules: no lead time), `GET /admin/api/customer?phone=` (returning-customer lookup). Signed-out requests get 401 JSON; pages redirect to `/admin/login?next=`.
- OWNER only (STAFF get a 403 page): `/admin/services` (+ `/new`, `/:id`, `/:id/active`, `/:id/move`, `/:id/delete`), `/admin/categories` (`POST` add, `/:id` rename, `/:id/move`, `/:id/delete`), `/admin/barbers` (+ `/new`, `/:id` profile, `/:id/hours`, `/:id/time-off`, `/:id/time-off/:offId/delete`, `/:id/move`), `/admin/zones`, `/admin/products`, `/admin/gallery` (each with `/new`, `/:id`, `/:id/move`, `/:id/delete`)
- All admins: `/admin/customers` (search by name, phone or email; sort), `/admin/customers/:id` (history, stats, `POST` name/email/notes), `/admin/account` (+ `POST /admin/account/password`). `/admin/bookings/new?phone=&name=` prefills the staff form.
- OWNER only: `/admin/reports?preset=week|lastweek|month|lastmonth|30d|90d` or `?from=&to=`, `/admin/settings` (+ `POST /admin/settings/booking|shop|home`, with `reset=1` to restore defaults), `/admin/users` (+ `POST /admin/users`, `/:id`, `/:id/active`, `/:id/password`)

**Home visits on or off.** `content.homeVisitsOpen()` is true only when an active barber does home visits, has working hours and offers at least one active home-visit service, and at least one zone is active. When it's false, the "Book a home visit" buttons are hidden, the home-visit section offers WhatsApp instead, step 1 of the wizard shows home visits as paused, and `POST /book/type` refuses `HOME`. `/api/zones` and `/api/services` send `Cache-Control: no-cache`, so changes show at once.

**Builder section and credit (client approved).** The home page has a "Website & booking system by Cyberninja Innovations" section just above the footer (`partials/builder-promo.ejs`). It uses the site's own tokens (dark panel, serif heading, amber accent, plus a hairline gold border, drifting glows and a cursor spotlight). It shows a live miniature of this site in a browser frame with floating "slot engine", "dashboard" and "booking confirmed" cards, and a slow service ticker; all of that is decorative and `aria-hidden`, and stills under reduced motion. It has 4 service chips (with icons) and 2 CTAs ("Get a website like this →" to the studio site with `utm_campaign=built-by`, and "Chat on WhatsApp"). Both links open in a new tab with `rel="noopener"`. Every public footer reads "© {year} {shop name} · Website by Cyberninja Innovations": the year is computed server-side, the name follows Settings, and the studio name links to the same UTM URL. The admin has no credit. The copy and links live in `src/config/credits.js`, and both parts can be switched off in Settings → Shop details.

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
| — | (new) | "Website & booking system by Cyberninja Innovations": 4 service chips, "Get a website like this →" and "Chat on WhatsApp" CTAs; shown when `shop.showBuilderSection` | `partials/builder-promo.ejs` | `config/credits.js`, `Setting` |
| 6 | "Take the Chair" footer | Big image-clipped CTA, hours, address, socials, WhatsApp; "© {year} {shop name} · Website by Cyberninja Innovations" when `shop.showBuilderCredit` | `partials/footer.ejs` | `Setting`, `config/credits.js` |

**Implementation notes (home page)**

- Section partials live in `views/partials/home/`; data comes from `services/content.js` (`getHomeContent`), copy from the `home` setting (code defaults in `config/constants.js` until the owner edits it).
- Responsive images follow `${base}-${width}.webp` (e.g. `/images/site/svc-skin-fade-900.webp`); `Service.imageUrl`, `Barber.photoUrl` and `Product.imageUrl` store the base path. Admin uploads write the same widths with `sharp` (`services/images.js`: services and barbers 500/900, products 400/800, gallery 600/1200) to `public/uploads/<kind>/<slug>-<random>-<width>.webp`, and the database stores the base path.
- Current photos are Pexels placeholders, listed in `public/images/site/CREDITS.md`.
- Motion: `public/js/boot.js` (pre-paint flags + 2.5 s failsafe), `site.js` (menu, sticky nav, reveals, parallax, rings, fit-text), `home.js` (hero timeline, marquee, Flip service filter, step progress, pinned product rail on desktop).
- Premium layer: first-visit intro loader (once per session, `sessionStorage`), desktop-only ScrollSmoother (created/destroyed with the `(min-width:1024px) and (pointer:fine)` breakpoint; fixed UI lives outside `#smooth-wrapper`), cursor companion that labels `[data-cursor]` targets and hides over round buttons, `*accent*` words in copy rendered by `rich()`, live open/closed status from barbers' `WorkingHours` (`shopStatus`), and a home-visit price estimator.
- The hero's rotating "Book Appointment" ring button (`partials/ring-btn.ejs`, `.ring-btn`) is signed off by the client: do not change its look, size, position or hover.
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

**Booking history.** Every change writes a `BookingEvent` in the same transaction as the change: creation (online or by staff), staff status actions, customer and staff reschedules (with from/to times and barbers, and a note when a home visit needs confirming again), and customer cancellations. The booking page shows it as a timeline. Existing bookings were backfilled from `createdAt`, `confirmedAt` and `cancelledAt` by the `booking_events` migration.

**Inactive barbers.** Switching "Taking bookings" off stops new bookings only. Existing bookings stand, so Today and the Calendar also list any inactive barber who still has bookings (marked "Inactive"), and saving the change lists their upcoming bookings so staff can move or cancel them.

**Customer counts.** "Bookings" means bookings that weren't cancelled, past and upcoming, everywhere (`customers.customerStats`): customer list, customer page and booking page. The list shows the last *past* visit and, separately, the next upcoming one.

**Status rules** (`services/adminBookings.js`, `allowedActions`):

| Action | From | When |
| --- | --- | --- |
| Confirm | PENDING | any time |
| Complete, No-show | CONFIRMED | once the appointment has started |
| Reschedule | PENDING, CONFIRMED | before it starts |
| Cancel | PENDING, CONFIRMED | any time; optional reason |
| Undo | COMPLETED, NO_SHOW | within 7 days, back to CONFIRMED |

A no-show adds 1 to `Customer.noShowCount`; undoing it takes 1 off. Every change runs in a transaction.

**Staff overrides.** Staff bookings and staff reschedules go through the same `createBooking` / `rescheduleBooking` path (same transaction, advisory lock and exclusion constraint) with three differences: no lead time, no customer cancellation cutoff, and home visits are CONFIRMED straight away. Staff bookings are stored with `source = STAFF`.

**Sign-in.** bcrypt (cost 12). Unknown emails are compared against a dummy hash so timing does not reveal which accounts exist. Five wrong passwords lock the account for 15 minutes. The session id is regenerated on sign-in, and `?next=` only accepts `/admin` paths.

**Build waves.** A: sign-in, Today, bookings, booking detail, staff booking, reschedule, calendar. B (OWNER): services and categories, barbers (hours, time off, photos), zones, products, gallery. C: customers, reports, settings, users.

**Catalogue rules** (`services/catalog.js`, `services/barbers.js`):

- Prices are typed in naira (`7,500`, `7500.50`) and stored in kobo. Durations come in 5-minute steps (5–480). Zone travel time is 0–180 minutes.
- Slugs come from the name and stay unique (`cut`, `cut-2`, …). Reordering rewrites `sortOrder` as 10, 20, 30… within the group.
- Anything with booking history is never deleted: a service with bookings must be hidden (`active = false`), a zone with bookings switched off, and barbers are deactivated rather than deleted. A category can only be deleted once it is empty. Products and gallery photos can be deleted, and their image files go with them.
- Weekly hours: one shift per day in Lagos wall-clock minutes. Saving replaces the barber's whole week in one transaction and lists any upcoming bookings that now fall outside it. Those bookings are not changed.
- Time off: all-day ranges run from 00:00 on the first date to 24:00 on the last, and ranges are capped at a year. Adding time off lists the overlapping bookings but does not cancel them; the owner decides.

**Reports** (`services/reports.js`). "Booked" revenue is every booking that still stands (pending, confirmed, completed); "taken" is completed visits only. Both use `Booking.totalKobo`; service breakdowns use the `BookingService` price snapshots. Each period is compared with the equal-length period before it. The no-show rate is out of visits that were due (completed + no-show). The average ticket is rounded to whole naira. Charts are inline SVG rendered on the server, so they need no script and no style attributes.

**Settings** (`services/settingsAdmin.js`). Three sections are saved as `Setting` rows. Booking rules are typed in hours (quarter-hour steps) and stored in minutes; the slot step is one of 5/10/15/20/30/60. Shop details and home copy are stored as one object each. Shop details also hold the two website-credit toggles, `showBuilderSection` ("Show builder section on home page") and `showBuilderCredit` ("Show builder credit in footer"), both on by default; rows saved before they existed fall back to the defaults. Each section's "Restore defaults" button belongs to its own form (`form="reset-…"`), so pressing Enter in a settings form always saves. Social links must be `https://` URLs, and the hero needs exactly three lines. Saving clears the in-process settings cache; with several PM2 workers, other workers pick up the change within 30 s. "Restore defaults" deletes the section's rows.

**Users** (`services/adminUsers.js`):
- Owners create accounts with a temporary password (same policy: 12+ characters, letters and a number).
- There is always at least one active owner.
- You can't change your own role or deactivate yourself.
- Deactivating an account or resetting its password deletes that admin's rows from the `session` table, so they are signed out at once.
- Changing your own password signs out your other devices and keeps the current one.
- PRG form state never stores password fields in the session.

**Uploads.** Image forms are `multipart/form-data`. `middleware/upload.js` parses them (memory storage, one file, 8 MB cap) before CSRF protection runs, so the hidden `_csrf` field is checked as usual. The file only reaches a handler after CSRF and the OWNER check pass. `sharp` decodes the buffer, rejects anything that isn't a JPG/PNG/WebP/AVIF/HEIF image or is under 400 px wide, applies EXIF rotation and writes WebP. Replaced or deleted images are removed from disk, and `removeUpload` only touches files inside `/uploads/<kind>/`. The sharp file cache is off because it holds Windows file handles open. The CSP allows `blob:` images so the picker can preview a photo before upload.

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
- CSRF tokens on every form; `express-rate-limit` on booking submissions and manage-link actions (10 per 15 min), the JSON API (60 per min) and `/admin/login` (20 per 15 min), per IP. When a limit is hit, pages get the branded 429 page (minutes until reset, plus a WhatsApp button for bookings), the JSON API gets `{ error: { code: 'RATE_LIMITED', message } }`, and the login form is shown again with the message. Limits use the in-memory store, so each PM2 worker counts separately.
- zod validation on every input; Nigerian phone numbers normalised to `+234…`.
- Admin passwords hashed with bcrypt (cost 12); login lockout after 5 failed attempts.
- Manage links use 32-byte random tokens; references are short and non-sequential.
- Customer addresses visible only to admins; production database backups daily.

**Deployment (Phase 6: Contabo VPS)**

1. Contabo VPS, Ubuntu 24.04 LTS (4 GB RAM is comfortable for v1: web, worker and Postgres on one box). Non-root deploy user, SSH keys only, `ufw` (22/80/443), `fail2ban`, unattended security upgrades.
2. **Self-hosted PostgreSQL 17** on the VPS, listening on localhost only. Nightly `pg_dump` (compressed, encrypted) shipped **off-site** (e.g. Backblaze B2 or S3-compatible storage via `rclone`), keeping 14 daily + 8 weekly copies; restore tested before launch.
3. Nginx reverse proxy + Let's Encrypt (certbot) for the domain; HTTP → HTTPS; long-cache headers for `/css`, `/js`, `/vendor`; `trust proxy` is set in the app.
4. PM2 (`ecosystem.config.js`): `web` in cluster mode (one per core) and `worker` as a **single** instance, so jobs never run twice (each job also takes an advisory lock as a safety net). `pm2 startup` + `pm2 save` for reboots; log rotation via `pm2-logrotate`.
5. **Images live on Cloudinary**, not on the VPS, so the server holds no user files: backups are the database only.
6. Deploys: GitHub Actions runs lint + Jest on push; on `main`, SSH → `git pull` → `npm ci --omit=dev` → `npm run build:css` → `prisma migrate deploy` → `pm2 reload ecosystem.config.js`.
7. Env vars: see "Environment" below.

## Build phases and open questions

Build runs in six phases, each ending in something the client can click; the availability engine comes before any UI polish because everything depends on it.

1. **Foundation:** repo, Express app, Prisma schema + migrations, seed data (categories, services, 2 barbers, 4 zones), layout + Tailwind setup.
2. **Booking engine:** `availability.js` with Jest tests (shift edges, buffers, overlaps, time off, "any barber"), transactional create, the `/api/slots` endpoint.
3. **Public site + booking flow:** the six home sections, service/barber/contact pages, 4-step booking wizard, confirmation and manage link.
4. **Admin dashboard:** ✅ login, today view, bookings, calendar, staff bookings, CRUD screens, customers, reports, settings, users, home-request confirmation.
5. **Production-ready (no deploy):** outbox notifications (email/SMS templates, retries, admin resend), a separate jobs worker (sends, reminders, auto-cancel, cleanup), hardening (env checks, CSP, logging without PII, health check, seeds split), images on Cloudinary, SEO and sharing, performance and accessibility (Lighthouse), and a launch content checklist (`docs/LAUNCH-CONTENT.md`).
6. **Deploy:** Contabo VPS, domain + DNS, TLS, Nginx, PM2 (web + worker), self-hosted Postgres with off-site backups, real content and photos, go-live checks.

## Environment

Validated with zod at boot (`src/config/env.js`); the app refuses to start on invalid values, and in production also on a weak or example `SESSION_SECRET` or a seed `ADMIN_PASSWORD`. The full list is kept up to date in the README.

**Open questions for the client**

- [ ] Shop name, logo, address and real opening hours?
- [ ] Full service list with prices and durations, and which are available for home visits?
- [ ] Number of barbers, their weekly hours, and which ones do home visits?
- [ ] Home-service zones (e.g. Lekki, Ikoyi, VI, Ajah, Ikeja, Yaba): fee and travel time per zone?
- [ ] Should home visits need manual confirmation (current plan) or auto-confirm like shop bookings?
- [ ] Lead time, cancellation cutoff and how far ahead customers can book?
- [ ] SMS budget and sender ID (Termii needs a registered sender name)?
- [ ] Domain, and who supplies the photography?
