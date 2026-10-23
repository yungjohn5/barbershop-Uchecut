# Victory Barbershop

Editorial marketing website and booking system for a barbershop in Lagos, Nigeria.
Customers book an in-shop appointment or a home visit without creating an account,
and pay on the day. One Node.js app serves the site, the booking engine and (soon)
the owner's dashboard.

> **Status:** Phases 1–4 complete: foundation, booking engine, public site, booking wizard,
> confirmation and manage link, and the full admin dashboard. Phase 5 (production readiness) is in progress; Phase 6 deploys to a Contabo VPS.
> See [Roadmap](#roadmap).
> "Victory" and all copy, prices, zones and photos are **placeholders** until the client signs off.

**Contents:**
[Features](#features) ·
[Tech stack](#tech-stack) ·
[Getting started](#getting-started) ·
[Configuration](#configuration) ·
[Scripts](#scripts) ·
[Project structure](#project-structure) ·
[How booking works](#how-booking-works) ·
[Front end](#front-end) ·
[API](#api) ·
[Testing](#testing) ·
[Conventions](#conventions) ·
[Troubleshooting](#troubleshooting) ·
[Roadmap](#roadmap)

---

## Features

**Booking engine**
- Two booking types:
  - **Shop:** confirmed immediately.
  - **Home visit:** the customer picks a zone, which adds a travel fee and a travel buffer. Starts pending until staff confirm.
- Slot generation from each barber's weekly hours, time off and existing bookings, with travel buffers applied on both sides of a home visit.
- Configurable lead time (2 h shop, 24 h home), booking window (30 days) and slot step (15 min).
- "Any barber" merges all eligible barbers' slots and assigns the least busy barber on confirmation.
- Double-booking protection at three layers:
  1. The availability check is re-run inside a `Serializable` transaction.
  2. A per-barber advisory lock is taken before the insert.
  3. A PostgreSQL exclusion constraint rejects any overlapping row.
- Money stored as integer kobo. Times stored in UTC and shown in `Africa/Lagos`.

**Website**
- Editorial home page: hero, intro collage, services with category filters, craft section, barbers, home-visit steps with a live price estimator, products, and a "Take the Chair" footer.
- Animation with GSAP: intro loader, smooth scrolling on desktop, line-by-line heading reveals, a Flip-animated services filter, and a pinned horizontal product row.
- Premium hover and press states for every button, with touch-friendly fallbacks.
- **Light and dark mode:** follows the OS until the visitor picks, the choice is remembered, and there is no flash on load. The sun/moon toggle reveals the new theme in a circle growing from the button. Text meets WCAG AA contrast in both themes.
- **Back-to-top button:** a frosted disc with a scroll-progress ring and a rolling arrow. It glides to the top and sits above the mobile "Book now" pill.
- Live "Open now / Closed" status computed from the barbers' working hours.
- Responsive from 360 px phones to 2560 px monitors. Content stays visible without JavaScript, and `prefers-reduced-motion` turns animation off.

**Admin dashboard** (`/admin`)
- **Today:** a greeting, four stat cards (bookings, requests awaiting confirmation, expected and taken revenue, this week), each barber's schedule with one-tap Complete / No-show, and the home-visit request queue with Confirm / Cancel.
- **Bookings:** Upcoming / Today / Pending / Past / All, search by name, phone or reference, filters for barber, type, status and dates. A table on desktop that becomes cards on phones.
- **Booking detail:** all the facts, status actions, cancel with a reason, and staff-only notes. Also the customer's upcoming and past bookings with their no-show count, Call / WhatsApp buttons, the customer's manage link to copy, and a full **history** of who booked, confirmed, moved or cancelled it, and when.
- **New booking:** for walk-ins and phone bookings. Free times load live, returning customers are filled in from their phone number, and the total includes the travel fee. No lead time, and home visits are confirmed straight away.
- **Reschedule:** the same barber, date and time picker as the public wizard, with staff rules applied.
- **Calendar:** a week per barber with travel buffers, closed hours and time off shaded, a red "now" line, and sideways scrolling on phones.
- **Sign-in:** bcrypt with a 15-minute lockout after 5 wrong passwords. Dark sidebar on desktop, slide-in drawer on phones, light and dark mode.
- **Owner screens:**
  - **Services and categories:** price in naira, duration, description, card photo, home-visit toggle, live/hidden, who offers each service, reorder, rename and delete.
  - **Barbers:** portrait, bio, specialties, services offered, home-visit and taking-bookings toggles, a weekly-hours editor with "copy Monday", and time off that warns about clashing bookings.
  - **Zones:** fee and travel time.
  - **Products and gallery:** photo upload with live preview, captions, barber tags, show/hide and reorder.
  - Anything with booking history is hidden, never deleted.
- **Customers:** search by name, phone (however it's typed) or email, and sort by last visit, visits, spend or no-shows. Each customer has a profile with a visit timeline, total spend, their usual service, staff notes, and a "Book them in" shortcut.
- **Reports (owner):** presets or a custom range, booked vs taken revenue with change against the previous period, a revenue-by-day chart, and breakdowns by barber, service, weekday and zone. Also shows the cancellation and no-show rates and the home and staff share.
- **Settings (owner):** booking rules (lead times, window, cutoff, slot step), shop details and socials, and every line of home-page copy. All are validated, take effect at once, and have a "restore defaults" option.
- **Users (owner):** add staff or owners, edit, reset passwords (with a strong-password suggester) and deactivate. Deactivated users are signed out at once, and there is always at least one owner. Everyone can change their own password under **Account**.

---

## Tech stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22 LTS |
| Server | Express 4, `helmet`, `compression`, `morgan` |
| Views | EJS + `express-ejs-layouts` |
| Styling | Tailwind CSS 3 (CLI build) |
| Motion | GSAP 3.15 (ScrollTrigger, SplitText, Flip, ScrollSmoother), served locally |
| Database | PostgreSQL 17 via Prisma 6 |
| Validation | `zod` |
| Dates | `date-fns`, `date-fns-tz` |
| Sessions & security | `express-session` + `connect-pg-simple`, `csrf-sync`, `express-rate-limit`, `bcrypt` |
| Messaging | `nodemailer` (SMTP), Termii SMS behind `sms.send()` (dry-run until configured) |
| Jobs / uploads | `node-cron`, `multer` + `sharp` |
| Testing / tooling | Jest, Supertest, ESLint 9, Prettier |
| Production | PM2 behind Nginx |

The stack is fixed. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing it.

---

## Getting started

### Prerequisites

- **Node.js 22+** (`.nvmrc` pins 22)
- **PostgreSQL 17** (16+ works), with a role that can create databases and the `btree_gist` extension
- Git

### Install and run

```bash
git clone <repo-url> uchecut
cd uchecut
npm install

cp .env.example .env          # then edit DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET, ADMIN_*

npm run db:migrate            # create tables + exclusion constraint
npm run db:seed               # categories, services, barbers, zones, products, owner admin
npm run build:css             # first CSS build

npm run dev                   # http://localhost:3000
```

`npm run dev` runs the server (nodemon) and the Tailwind watcher together. Edits under
`src/` restart the server, and template and CSS changes show on refresh.

The admin dashboard is at <http://localhost:3000/admin>. Sign in with the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` you set in `.env` before seeding. The seed creates that OWNER account once
and never changes its password afterwards.

To generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Configuration

All configuration comes from environment variables, validated at start-up by
[src/config/env.js](src/config/env.js). The app refuses to start with a clear message if a
required value is missing.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | 32+ random characters for signing session cookies |
| `TEST_DATABASE_URL` | for tests | Separate database whose name **must end in `_test`** |
| `PORT`, `APP_URL`, `NODE_ENV`, `TZ` | | Server basics (`TZ=Africa/Lagos`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | for seed | First OWNER account (password ≥ 12 characters) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | | Email; logged instead of sent while `SMTP_HOST` is empty |
| `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_BASE_URL` | | SMS; dry-run while unset |

Shop-level settings (lead times, booking window, cancellation cutoff, opening-hours text,
address, socials, home-page copy) live in the `Setting` table. Defaults are in
[src/config/constants.js](src/config/constants.js), and stored values override them field by field.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with auto-restart + Tailwind watch |
| `npm start` | Production server (`node src/server.js`) |
| `npm run build:css` | Minified CSS build to `public/css/app.css` |
| `npm test` | All tests (unit + integration), serially |
| `npm run test:unit` | Unit tests only (no database) |
| `npm run test:integration` | Integration tests against `TEST_DATABASE_URL` |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run db:migrate` | Create and apply migrations (development) |
| `npm run db:deploy` | Apply migrations (production / CI) |
| `npm run db:seed` | Seed data (safe to re-run) |
| `npm run db:reset` | Drop, re-migrate and re-seed the dev database ⚠️ |

---

## Project structure

```text
uchecut/
├── docs/ARCHITECTURE.md      # source of truth for decisions, data model, phases
├── prisma/
│   ├── schema.prisma         # 15 models; all DateTimes are timestamptz(3)
│   ├── migrations/           # includes the raw-SQL booking exclusion constraint
│   └── seed.js               # idempotent placeholder data
├── public/
│   ├── css/app.css           # built (git-ignored)
│   ├── js/                   # boot.js, site.js (shared), home.js, booking.js (wizard), admin.js
│   └── images/site/          # responsive WebP placeholders + CREDITS.md
├── src/
│   ├── app.js / server.js    # Express app, graceful shutdown
│   ├── config/               # env validation, constants and default settings
│   ├── lib/                  # prisma, logger, errors, phone, time, ids, sms, mailer, view helpers
│   ├── middleware/           # csrf, rate limits, zod validate(), error handler
│   ├── services/             # business logic: availability, booking, bookingFlow, admin*, catalog, barbers, customers, reports, images, content, settings*
│   ├── routes/               # public pages, booking wizard, JSON API, admin/
│   ├── styles/input.css      # Tailwind source + component styles
│   └── views/                # layouts, partials (home sections), pages
└── tests/
    ├── unit/                 # pure logic, no database
    └── integration/          # real Postgres: booking races, API, page rendering
```

Routes stay thin and business logic lives in `src/services/`. Anything added there needs Jest tests.

---

## How booking works

**Slots**

[`computeSlots()`](src/services/availability.js) is a pure function (no database, no clock)
and is fully unit-tested. For a given date, barber (or "any"), services, type and zone it:

1. Sums the service durations and rejects a home visit that includes a shop-only service.
2. Uses the zone's travel buffer for home visits (0 for shop visits).
3. Walks each shift in 15-minute steps. A start time `s` is valid when
   `[s − buffer, s + duration + buffer]` fits inside the shift and overlaps no active booking or time off.
4. Drops slots inside the lead time or beyond the booking window.
5. For "any barber", merges slots across eligible barbers.

**Creating a booking**

[`createBooking()`](src/services/booking.js) runs in one `Serializable` transaction:

1. Re-runs the full slot check against the latest data.
2. Picks the barber (the least busy one for "any").
3. Takes `pg_advisory_xact_lock(7341, barberId)` so concurrent attempts on one barber queue up instead of deadlocking.
4. Re-checks for overlap, then inserts with a price and duration snapshot of each service.

Error handling:
- Exclusion violations (`23P01`) become `SlotTakenError` (HTTP 409).
- Serialization conflicts (`P2034` / `40001`) are retried up to 3 times with jittered backoff, then return 503.

As a final safety net, the `Booking_no_overlap` constraint makes overlapping active
bookings impossible even if the application has a bug.

---

## Credits

Designed and built by [Cyberninja Innovations](https://cyberninjainnovations.com/). The home page has a "Website & booking system by" section just above the footer, and every public footer reads "© {year} {shop name} · Website by Cyberninja Innovations". The text and links are in `src/config/credits.js`. The owner can switch either off in **Settings → Shop details**.

## Front end

- **Design:** Gloock headings, DM Serif Display italic accents, Inter body text (16 px minimum on mobile). Palette: paper `#F4F1EC`, ink `#141414`, amber `#B8833E`.
- **Accent words:** copy can mark one word with `*asterisks*`, which renders as an italic amber accent via `rich()`.
- **Images:** stored as `${base}-${width}.webp`. `Service.imageUrl`, `Barber.photoUrl` and `Product.imageUrl` hold the base path. Current photos are Pexels placeholders, listed in [public/images/site/CREDITS.md](public/images/site/CREDITS.md).
- **Motion:**
  - [boot.js](public/js/boot.js) sets pre-paint flags, with a 2.5 s failsafe.
  - [site.js](public/js/site.js) handles the menu, sticky nav, smooth scrolling, reveals, cursor and buttons.
  - [home.js](public/js/home.js) handles the loader, hero, marquee, filters, estimator and product row.
- **Theming:**
  - Colours are CSS variables (`--paper`, `--ink`, `--surface`, …) that Tailwind reads, so `bg-paper` and `text-ink/60` follow the theme.
  - `night` and `cream` never change; use them for dark text on amber and for shades over photos.
  - Wrap always-dark sections in `.keep-dark`.
  - `boot.js` sets `data-theme` before first paint, from the saved `vb-theme` value or the OS setting.
- **Buttons:** `.btn-primary`, `.btn-light`, `.btn-ghost` and `.btn-ghost-light` get the rolling-label hover markup at runtime. Use them for any new button. Text links use `.link-u` or `.link-line`.
- **Client sign-off:** the hero's rotating **"Book Appointment"** ring button (`partials/ring-btn.ejs`, `.ring-btn`) is approved as is. Do not change its look, size, position or hover.
- **CSP:** scripts load only from `'self'`, so GSAP is served from `node_modules` at `/vendor/gsap`. Inline `<script>` tags and `style` attributes are blocked; use classes. `blob:` images are allowed for the admin upload preview.
- **Uploads:** admin photos are written to `public/uploads/` (git-ignored). Back this folder up and keep it across deploys.

---

## Booking flow

| Page | Path |
| --- | --- |
| 1. Visit (shop or home + area) | `/book` (accepts `?type=`, `?service=`, `?barber=`) |
| 2. Services | `/book/services` |
| 3. Barber, date and time | `/book/time` |
| 4. Details and confirm | `/book/details` → `POST /book` |
| Confirmation | `/book/confirmed/:reference` (only in the booking session) |
| Manage (view, reschedule, cancel, calendar) | `/manage/:token` |

The draft lives in the session, every step works without JavaScript, and later steps redirect to the first incomplete one. Customers can reschedule or cancel up to the cutoff (`cancelCutoffMin`, default 3 h).

## API

Read-only JSON endpoints used by the booking widget (rate-limited):

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/zones` | Active zones with fee and travel buffer |
| GET | `/api/services?type=HOME` | Services allowed for that booking type |
| GET | `/api/slots?date=2026-10-20&barber=any&services=1,4&type=HOME&zone=1` | `{ date, slots: [{ time, startsAt, barberIds }], subtotalKobo, homeFeeKobo, totalKobo, … }` |

Errors use one shape: `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [...] } }`.

---

## Testing

```bash
npm test
```

- **Unit tests:** shift edges, buffers, overlaps, time off, lead time, booking window, "any barber", pricing, phone normalisation, error classification, settings, view helpers and opening-hours status.
- **Integration tests:** run against `TEST_DATABASE_URL`. Global setup creates the database if needed and applies migrations. The suite refuses any database whose name doesn't end in `_test`, so dev data is never touched. Covered:
  - real booking flows
  - a forced race (every attempt passes the availability check before inserting, and exactly one wins)
  - a direct insert that the exclusion constraint must reject
  - the JSON API and the home page
  - admin sign-in and lockout, route guards, status actions, staff bookings, reschedule, the week calendar
  - owner-only access, catalogue CRUD rules, weekly hours and time off, and multipart uploads behind CSRF
  - customers, reports, settings taking effect on the public site, user management and session sign-out

---

## Conventions

- **Money:** integer kobo everywhere (`750000` = ₦7,500). Format with `naira()` in views.
- **Time:**
  - Store UTC (`timestamptz`) and display in `Africa/Lagos`.
  - Calendar dates are `YYYY-MM-DD` strings in shop time.
  - Weekly hours are minutes from midnight.
- **Phones:** normalised to `+234XXXXXXXXXX` before storage.
- **Architecture doc:** if a change contradicts [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), update the doc in the same commit.
- **Commits:** small, descriptive, one concern each. Lint and tests must pass.

---

## Troubleshooting

**`npm : running scripts is disabled on this system` (Windows PowerShell)**
Run once, then open a new terminal:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
Or run `npm.cmd run dev`, or use Command Prompt or Git Bash.

**`Invalid environment configuration` on start**
A required variable is missing from `.env`. The message names it.

**Integration tests refuse to run**
`TEST_DATABASE_URL` must point to a database whose name ends in `_test`.

**`permission denied to create extension "btree_gist"`**
The database role needs rights to create extensions, or a superuser must create it once:
`CREATE EXTENSION btree_gist;`

**Port 3000 already in use**
Stop the other process, or set `PORT` in `.env`.

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation: app shell, schema, migrations, seed | ✅ Done |
| 2 | Booking engine, transactional create, JSON API, tests | ✅ Done |
| 3 | Public site and booking wizard, confirmation, manage link | ✅ Done |
| 4 | Admin dashboard: Today, bookings, staff booking, calendar, catalogue, team, customers, reports, settings, users | ✅ Done |
| 5 | Production-ready: outbox notifications, jobs worker, hardening, Cloudinary images, SEO, performance, launch content | 🟡 In progress |
| 6 | Deploy: Contabo VPS, domain, TLS, PM2 web + worker, self-hosted Postgres with off-site backups | ⬜ |

**Needed from the client:**
- shop name and logo
- real services, prices and durations
- barbers and their hours
- home-visit zones with fees and travel times
- policies (lead times, cancellation)
- SMS sender ID
- photography

---

## License

Proprietary. All rights reserved. Placeholder photography is from [Pexels](https://www.pexels.com/license/)
and must be replaced with the client's own images before launch.
# barbershop-Uchecut
