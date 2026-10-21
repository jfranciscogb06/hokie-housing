# Hokie Housing scraper

Pulls every listing on **offcampus.vt.edu** (Virginia Tech's official off-campus
housing portal) and writes the files the website reads. Nothing runs in the
background — you run it when you want fresh data.

```
hokie-housing/
├── index.html            the site (loads data/listings.js)
├── data/
│   ├── listings.js       ← what the site reads
│   ├── listings.json     same thing, plain JSON
│   ├── changes/          one file per run: new / removed / price changes
│   ├── raw/              cached portal records (placards + per-listing details)
│   ├── amenities.json    amenity id → name, learned as we go
│   └── scrape.log
├── photos/<id>/*.jpg     downloaded, resized to 1600px, ~150–400KB each
└── scraper/
    ├── run.sh            ← run this
    ├── scrape.py         the pipeline
    ├── ocp.py            access layer for the portal
    └── requirements.txt
```

## Run it

```bash
cd scraper
./run.sh                       # incremental: full catalog, details only for changed listings, missing photos
./run.sh --details all         # re-fetch every listing's detail page (~15 min)
./run.sh --pages 2 --radius 2  # quick dev run
```

First run installs a venv and does everything (~45 min: ~540 listings, ~8 photos each).
After that a run is usually 2–5 minutes: 17 search pages + whatever changed.

Then open `index.html` (or serve the folder: `python3 -m http.server 8787`).

## How it works

**Getting past the bot wall.** The portal is Apartments.com/CoStar under the hood,
fronted by Akamai Bot Manager. Plain HTTP clients, Playwright's Chromium and
Chrome-headless all get a flat 403. `curl_cffi` impersonating Chrome's TLS
fingerprint gets through with no browser at all, so that's the default transport.
If Akamai ever tightens it, `--browser` drives a real Google Chrome window instead
(needs a desktop session; on a Mac the window is hidden automatically).

**No HTML parsing.** Every page embeds `<script id="ocp-state">`, an Angular
transfer-state blob that caches the page's own backend responses. The search page
carries all 40 placards (price, coords, photos, `lastUpdated`); the property page
carries the full record (floor plans, amenities, reviews, manager). We read that JSON.

**Complete catalog.** The portal randomizes result order per request, so paging the
17 search pages is leaky (~450 unique cards out of ~650 listings, with repeats). The
search response also carries `pins` — every listing id with coordinates — so that is
the master list; any in-range listing the pages didn't show is fetched by id
(`/housing/property/x/<id>`) and its card is built from the full record.

**Incremental.** Each run re-crawls the search pages (cheap), then only opens a
listing's detail page if its `lastUpdated` changed (pin-only listings refresh weekly).
Photos are keyed by the CDN's image id so they're downloaded once. If downloads start
failing in a row the session is reset with a pause; if that keeps happening the photo
phase is skipped and the run still publishes — rerun later to fill in.

**Photos.** Apartments.com-hosted photos come at 2048px (size code `116`);
landlord-uploaded photos come through the portal's image resizer at 1600px. Both
get re-encoded to progressive JPEG ≤1600px. The first photo is the listing's own
main photo.

**Polite.** ~1 request/second, one connection, `Referer` set, no parallelism.
A full first run is ~5,000 requests; a normal run is ~50.

## Options

| flag | default | |
|---|---|---|
| `--radius MILES` | 8 | only publish listings within N miles of Burruss (8 = Blacksburg + Christiansburg) |
| `--photos N` | 8 | photos per listing (0 = don't touch photos) |
| `--details changed\|all\|none` | changed | which detail pages to open |
| `--max-details N` | — | cap detail fetches this run |
| `--pages N` | all | only the first N search pages (dev) |
| `--delay SEC` | 1.0 | pause between page loads |
| `--browser` | off | use a real Chrome window instead of curl_cffi |

## Running it somewhere else

The scraper and the site are independent: the scraper produces `data/` + `photos/`,
the site just reads them. So it runs anywhere Python 3.11+ runs — a Render/Railway
cron job, a free-tier VM, GitHub Actions — and you `rsync`/upload the output to
wherever the site is hosted. Only `--browser` mode needs a desktop.

## What the site shows per listing

`name, type, price (+priceHigh, priceLabel, perBed), beds/bedsHigh, baths, sqft,
walk (est. min to Burruss), driveMin, busStop {name, walkMin, routes}, distanceMi,
bus, lease, furnished, utilities, pets, audience {undergrad, grad, faculty}, rating,
reviews (+reviewsList, from Apartments.com), area, address, lat/lng, photos[],
photosByBeds {"4": [...]}, planPhotos {"4": path}, plans[] {name, beds, baths, price,
sqft, status, availableDate, image}, tours[] (Matterport), amenities[], desc,
overview, pros[], cons[], sublet, shared, availability, manager, website, phone,
email, sourceUrl, lastUpdated`

**Bus stops** come from Blacksburg Transit's public GTFS feed (`bt.py`, cached weekly
in `data/bt_stops.json`): only stops served by a route that also stops on campus
count, and each listing gets its nearest one within 0.6 mi.

**Commute** shown on cards: walk if ≤20 min, else the bus if a stop is ≤8 min away,
else the portal's drive time.

**Per-bed pricing** is derived from the numbers (the portal's own flag is unreliable):
rent/bedrooms under $450 → per bed; or a bigger plan priced at or below a smaller one.

**Overview / pros / cons** are rule-based from the listing's own data (commute, bus,
reviews, amenities, price vs. the median for that bed count, availability, audience).
No LLM is called; to swap in a model, generate them in `build_overview()` and cache.

## Messaging properties (Request info / Request a tour)

Students message a property from its page. Three paths, chosen automatically:

1. **Sent directly** (when `RESEND_API_KEY` and `MAIL_FROM` are set on the server):
   `POST /api/message` emails the property from Hokie Housing with **Reply-To set to the
   student**, so the property's reply goes straight to the student's VT inbox. The student
   gets a copy. Requires an @vt.edu address; rate-limited per student, per IP and per day;
   has a honeypot for bots. The recipient is looked up on the server, never sent by the
   browser, so the endpoint can't be used to email arbitrary addresses.
2. **Gmail draft** (no mail settings, or the mail service fails): the same message opens in
   Gmail addressed to the same verified recipient; the student hits send.
3. **Text / Call** (property has no published email): Text opens the phone's messages app
   with the message prefilled.

Recipients come from `data/contacts.json`: public leasing emails from each management
company's or property's own website, keyed by the manager name on the portal. It covers
242 of 435 listings (Townside, River Mountain, Price, Roost, Core Spaces/Hub, Brexx,
Pointe West/Granite, Roanoke Street, Dogwood/Turner NW). The rest are mostly individual
owners who only list a phone. To add one: find the address on their site, add
`"Manager name": { "email": ..., "source": ... }`. Remove any that bounce or object.

**Turning on direct sending:** create a Resend account (free tier: 3,000 emails/month),
verify your domain's DNS records there, then set on the host:
`RESEND_API_KEY=re_...` and `MAIL_FROM=Hokie Housing <messages@your-domain>`.

## Shared interested-student lists

Now built: see [backend/README.md](../backend/README.md) — VT Google sign-in, owner-scoped
database rules, and email shared only on opt-in. Never enable anonymous write policies.

## Known gaps / next steps

- Photos have no captions on the portal, so "pool vs bedroom" isn't tagged. The first
  photo is whatever the landlord chose as their main photo. Filtering amenity shots
  would need an image classifier.
- Per-bed vs whole-unit price is flagged (`perBed`) but price sorting mixes them.
- `sublet: true` / `shared: true` listings (~45 / ~70) are in the catalog and badged
  in Explore; the Subleases and Roommates tabs still use the demo data.
- Walk time is an estimate (straight-line × 1.3 at 20 min/mi); the portal's routed
  number is kept as `walkRouted` but runs ~3× straight-line.
