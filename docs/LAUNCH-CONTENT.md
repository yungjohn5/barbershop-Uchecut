# Launch content checklist

Everything the shop owner needs to supply before the site goes live. All of it is entered in
the admin, so no code changes are needed. Until it's done, the owner's **Today** page shows a
**Before you launch** card listing what's still placeholder; it disappears when the list is
empty. **Must do** items block launch; **nice to have** items can follow in the first week.

Sign in at `/admin` with the owner account.

## 1. Shop details: must do

**Settings → Shop details**

| What | Example | Notes |
| --- | --- | --- |
| Shop name | Victory Barbershop | Used in the header, footer, emails, SMS and Google results |
| Tagline | Sharp lines. Quiet confidence. | One line; also the Google/WhatsApp preview text |
| Address | 12 Admiralty Way / Lekki Phase 1, Lagos | Up to 4 lines, shown in the footer and Google |
| Phone | +234 803 123 4567 | Shown on the site and in messages |
| WhatsApp number | 2348031234567 | Country code, no plus or spaces |
| Email | hello@yourdomain.ng | Owner alerts go here unless `OWNER_EMAIL` is set |
| Opening hours text | Mon–Fri · 10:00 – 20:00 | Footer only; bookable times come from each barber's hours |
| Map pin *(nice to have)* | 6.4281, 3.4219 | In Google Maps, right-click the shop and click the numbers |
| Social links *(nice to have)* | https://instagram.com/… | Blank ones are hidden |

## 2. Services and prices: must do

**Services** (`/admin/services`)

For each service: name, category, price (₦), duration (minutes), a one-line description,
whether it's offered on home visits, and a photo. Remove or hide any demo services.

## 3. Barbers and hours: must do

**Barbers** (`/admin/barbers`)

For each barber:

- name and a 1–2 sentence bio
- up to 3 specialties
- whether they do home visits
- which services they offer
- a portrait photo
- **weekly working hours**, without which nobody can book them
- known time off

## 4. Home-visit zones: nice to have

**Zones** (`/admin/zones`)

List the areas served with a travel fee (₦) and travel time each way. Home visits stay hidden
on the site until there's at least one active zone, plus a barber who does home visits.

## 5. Photos: nice to have, but they make the site

The site ships with stock placeholder photos. Replace them with the shop's own.

| Where | Admin page | Best size | Tips |
| --- | --- | --- | --- |
| Hero (top of home page) | Settings → Site photos → Hero | 2000 px+ wide, landscape | Dark, moody, a cut in progress; the left third sits under text |
| Intro, craft, home-visit and footer photos | Settings → Site photos | 1600 px+ | Portraits for "portrait" slots, landscape for the rest |
| Barber portraits | Barbers → edit | 1000 px+, portrait (3:4) | Same background and light for every barber |
| Service photos | Services → edit | 1000 px+, portrait (4:5) | One clear subject per photo |
| Products | Products | 800 px+, square | Plain background |
| Gallery | Gallery | 1200 px+ | Finished cuts, good light |

JPG, PNG or WebP, up to 8 MB each. Photos are stored on Cloudinary and resized automatically.
The hero photo also becomes the preview image when the site is shared on WhatsApp, X or
Facebook.

## 6. Words: nice to have

**Settings → Home page**

The home page ships with starter wording. Read every section and make it sound like the shop.
Mark one word per heading with `*asterisks*` to show it in the gold italic accent.

## 7. Booking rules: check

**Settings → Booking rules**

Check these against how the shop actually works:

- lead times for shop and home bookings
- how far ahead people can book
- the cancellation cutoff
- the slot step
- how long an unconfirmed home request waits before it's auto-cancelled

## 8. Products: nice to have

**Products** (`/admin/products`)

These are display only (no online payment): name, price, a short description and a photo. Hide
any you don't stock.

## 9. Staff accounts

**Users** (`/admin/users`)

Add a STAFF account for anyone who manages bookings but shouldn't change prices or settings.

## For the developer (before go-live)

- `.env` in production: real `MAIL_FROM` (the app refuses the example sender in live mode),
  SMTP and Termii keys, `CLOUDINARY_URL` with a `prod` folder, an `https://` `APP_URL`, and a
  strong `SESSION_SECRET`. See the README.
- Run `npm run images:upload` once if any records still point at bundled photos.
- Send a test booking end to end: confirmation email and SMS, manage link, reminder.
- Check the share preview (paste the URL into WhatsApp) and Google's Rich Results Test for the
  `BarberShop` data.
- Once production photos are all on Cloudinary, ship the migration that drops the
  `legacyImagePath` / `legacyPhotoPath` columns.
