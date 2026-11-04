# Blacksburg Housing

A student-built off-campus housing search for Blacksburg: listing photos,
natural-language search, floor plans, bus stops, saved places and Gmail contact drafts.
Browsing is public. Accounts and shared roommate features remain hidden until configured.

## Run it

```bash
npm start
# open http://localhost:8788
```

Use Node 22+; there are no installed dependencies or build step. The app loads
React via CDN and reads the checked-in `data/listings.js`. Without an API key,
built-in natural-language search works. The Node server also runs the homepage
sponsorship endpoints and keeps operator config and metrics out of public assets.

For optional AI interpretation:

```bash
cp .env.example .env
# Set OPENAI_API_KEY in .env using a local editor, then restart npm start.
```

Never put the key in the HTML or a browser setting. `.env` is git-ignored and the
server serves only public app assets. The AI endpoint is `POST /api/search`.
`OPENAI_SEARCH_MODEL` defaults to `gpt-4o-mini` and can be changed server-side.
Without a key, the app clearly reports built-in search; it does not pretend the
model is connected. GitHub Pages alone cannot run the AI endpoint.

The browser sends only the search text to the same-origin endpoint. The server
uses the [OpenAI Responses API with structured output](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
to return validated filter data; the browser filters the actual catalog. No
model-generated code, invented listings, or account/profile data are used.
Requests are debounced and canceled when a search changes, bounded to 500
characters, cached, and timed out. The endpoint includes per-process rate limits
(20/minute per IP, 300/hour total); production hosting should also enforce a
shared rate/spend limit across instances. Set the key in the hosting environment;
for a Node service, run `npm start` with `HOST=0.0.0.0` and its assigned `PORT`.

Examples: `5min drive away from campus`, `10 minute walk under $1000`,
`undergrad-friendly 2 bedrooms with a gym`, and `hub under $1500`.
Bare commute times mean **at most** that many minutes to central VT campus.
Driving uses the saved `driveMin`; unknown times don't pass. A bus-stop time means
walking to the stop, not the bus ride. Budget and bedroom requirements must match
the same floor plan. Specific per-bed and whole-unit budgets are kept distinct.
Noise/safety judgments, bus ride times, and live availability aren't inferred.
Unsupported criteria are surfaced instead of silently treated as satisfied.

## Home and search layout

Home opens with a licensed downtown Blacksburg photograph and gentle motion.
Scrolling or **Explore housing** reveals the search tools and real catalog listings
on the same page. Search in the top navigation skips the landing. Reduced-motion
preferences disable animation and smooth scrolling. Submitting the form (including Enter), choosing an
example, or viewing all housing opens Search. Desktop Search shows a map on the
left and independently scrolling result cards on the right, below the query and
filter toolbar. Phones use a three-item Home/Search/Saved bottom bar and a
separate Menu for other sections/account actions. Search shows only the query,
a Filters button and a Show map button; price, beds, eligibility and sort move
into a large bottom sheet. Cards use larger prices/titles, 44px photo controls
and fewer badges. Search interpretation and source details are accessible in
the sheet, while unsupported-query warnings stay visible. Rent pins open
listing details; closing details preserves the current search and filters.
Pins include the rent basis and use matching-plan pricing when constrained.
To keep dense areas readable, larger sets show rent labels for the first twelve
results (six in narrow maps) and dots for the rest; every marker has a property/rent tooltip and
keyboard access. Locations come from the catalog and should be confirmed.

## Student eligibility

Search has an **Undergrad-friendly** filter, plus grad/faculty and unstated
eligibility options. Cards show undergrad eligibility; details show the source
phrase when a description provides it. Explicit phrases such as “Undergrads not
permitted,” “No undergrads,” and “Graduate students only” override broad portal
audience tags. Explicit undergrad-friendly descriptions can establish eligibility.
Unknown remains unknown and is excluded from student-specific filters. Confirm
current restrictions with the property before applying.

The saved catalog is normalized at runtime; `scraper/eligibility.py` applies the
same rules on future refreshes and saves the description evidence. On this
catalog, 165 description/tag contradictions are corrected, giving 352 listings
marked undergrad-friendly and 181 restricted. These are listing claims, not an
independent verification. Marketing descriptions are collapsed by default behind
**Read property description**; useful facts and restrictions remain visible.

Run `npm test` to check parsing, eligibility precedence, real-catalog filtering,
same-plan budgets, unknown data, and the API adapter using simulated responses.
Live model quality still requires testing with a configured API key.

Photos aren't in the repo (800MB). The site falls back to the original CDN images, so
it works on a fresh clone. To get local copies: `./scraper/run.sh --details none`.

## Refresh the listings

On demand only — nothing runs on a schedule.

- **From GitHub (no laptop needed):** Actions tab > **Refresh listings** > Run workflow.
  It re-crawls the portal, runs the tests, and commits `data/listings.*` if anything
  changed. A host that deploys from `main` picks it up automatically. Photos are served
  from the original CDN in this mode.
- **Locally:** `./scraper/run.sh` (also downloads photos to `photos/`).

See [scraper/README.md](scraper/README.md) for how it works and the options.

## Deploy (Render)

1. render.com > New > Blueprint > pick this repo. `render.yaml` defines one Node web
   service plus a 1GB disk for sponsorship metrics.
2. Contacting properties needs no mail provider or Google account integration. Students
   review and send their own prefilled Gmail drafts. Set `SUPPORT_EMAIL` when your
   site contact address is ready. `OPENAI_API_KEY` is optional; built-in search works
   without it. Keep `TRUST_PROXY_HOPS=0` unless a trusted proxy chain is verified.
3. Add your domain under Settings > Custom Domains and point DNS at it.

The host doesn't need the 800MB `photos/` folder: missing local photos redirect to
their CDN copies.

## Config (in `index.html`)

- `SUPPORT_EMAIL` (server environment) populates `CONTACT.inbox` through the public
  `/site-config.js` response. Shown on Privacy and Terms, used for Advertise requests,
  and enables the "For property managers" page. No address is invented when blank.
- Messaging: `data/contacts.json` maps published leasing emails. Every property inquiry
  opens Gmail; no server mail endpoint is active. Text, Call and property links are alternatives.
- `BACKEND` — Supabase URL + anon key: VT Google sign-in and shared "I'm interested"
  lists. Setup and database rules: [backend/README.md](backend/README.md).
- `SPONSOR_OFFER` — homepage sponsorship slots, terms and (optional) price shown on the
  "For property managers" page.

## Before launch

- Set `CONTACT.inbox` (see Config).
- Review `/privacy` and `/terms` (in `index.html`, `LegalPage`) with someone qualified; update
  `LEGAL_UPDATED` whenever they change. Google sign-in needs the `/privacy` URL.
- Data rights: listings, photos and reviews come from offcampus.vt.edu (CoStar/Apartments.com).
  Get permission (VT Off-Campus Housing, CoStar, or the management companies) before a public
  launch, and especially before selling sponsored placements.

## Layout

```
index.html        the app UI
housing-search.js shared search schema, filters, and built-in parser
eligibility.js    description-based student restriction rules
catalog.js        load-time cleanup: address titles, grouped sublets, photos first
backend/          Supabase schema + setup for accounts and shared interest lists
render.yaml       Render deployment
.github/workflows on-demand catalog refresh
api/search.js     server-side AI interpretation
server.js         local app/API server
data/listings.js  the catalog (generated)
scraper/          the pipeline (Python)
photos/           local photos (generated, git-ignored)
```

## Release status (November 3, 2026)

The search beta includes public browsing, same-plan budget filters, maps, property
profiles, floor plans, photos, local saved places and Gmail draft history. Accounts,
shared interests, demo subscriptions and demo social pages are not exposed in this
release. The floating assistant launcher is removed; natural-language search remains.

`POST /api/message` returns 410 and cannot send email. The old standalone mail module
is retained for reference and isolated tests, but the server does not import it.
Support email, final domain selection and content rights remain owner decisions.
Run `npm test` before deploying. Browser QA and the deployed catalog must also be checked.

## Photo layout preference

Listing detail pages use the supplied Airbnb-style reference: one large image on
the left and a 2×2 grid on the right, narrow white gaps,
rounded outer corners, title above, and a Show all photos button at bottom right.
Gallery actions are compact buttons over the gallery: Show all photos opens the
lightbox and Google Images opens an external search. No image tile is replaced
by a large empty action panel. On mobile the gallery displays the lead image with
compact actions below.
Keep gallery/lightbox navigation by arrows, keyboard, and swipe. Accommodate
listings with fewer than five images without duplicating pictures. Bedroom-count
and floor-plan selection still determine the photo set.

## First-release scope (October 13, 2026)

The public beta opens without an account. Navigation is Home, Search, Saved,
and Contact history. Saved places and draft history are stored on this device.
Simulated Pro, admin, landlord accounts, user reviews, roommate profiles and
sublease posting are not exposed. Real sublets remain searchable in the catalog.
Interested-student matching is staged until authenticated, owner-scoped storage
is available; do not deploy the old anonymous write policies in scraper/README.md.

Remaining release gates: refresh and spot-check catalog pricing/availability;
verify photos on hosting without the local photo cache; choose hosting and
connect a domain. Shared interest lists follow with real auth and database policies.
Use `npm start` for the current app and optional search API.

## Homepage sponsorships

Revenue comes from selling fixed-term homepage placements to property managers.
Arrange a fee and payment directly, then activate a campaign for its agreed term.
There are two slots, clearly labeled **Sponsored**; each opens the ordinary
property profile. Campaigns expire automatically, and pausing removes a placement.
Sponsored placements do not change organic search results or near-campus picks.
The old demo featured flags do not label unpaid listings as ads.

Use `npm start`. Locally, campaigns are managed in `sponsorships/campaigns.json`.
When `DATA_DIR` is set, both the server and operator CLI use that directory:
`sponsor-campaigns.json` and `sponsor-stats.json`. The campaigns file is seeded
from the repository once, without overwriting existing campaigns on redeploy.
Run the operator command on the host (with the same `DATA_DIR`) to manage live
campaigns; later edits to the seed file do not replace the persistent file. That file and the metrics are not
served to visitors; there is no public campaign-write or pretend-payment endpoint.

```bash
npm run sponsors -- list
npm run sponsors -- add sbs6q75 --advertiser "Property manager"
npm run sponsors -- activate CAMPAIGN_ID --days 30
npm run sponsors -- pause CAMPAIGN_ID
npm run sponsors -- stats
```

The included Hub/Edge campaigns are drafts, not paying clients. Preview their
layout at `http://localhost:8788/?previewSponsors=1`. Draft previews are restricted
to loopback requests and say **Ad preview**; preview clicks/views never enter live
metrics. The normal homepage hides the sponsored row when no campaigns are live.
A campaign may choose `coverPhoto` from that listing’s catalog gallery or
bedroom-specific photos (or use `--photo` when creating a draft). Unknown photo
references fall back to the listing’s lead photo. Keep campaign IDs stable for reporting; check the listing's current rent and photos
and the advertiser's permission before activating a paid placement.

Views are counted after a card is at least half visible for one second, once per
page session. Clicks count property-profile opens. Aggregate daily counts are kept
for 90 days in `DATA_DIR/sponsor-stats.json` (or git-ignored
`.local/sponsor-stats.json` locally), without raw visitor logs.
These basic counts are not unique visitors, a guarantee of leads, or audited ad
billing. The endpoint has a per-process abuse limit. A deployed version needs
a writable `DATA_DIR` for persistent campaign config and metrics (provided by
the Render disk). Without a disk, runtime edits and counters can be lost on
redeploy/restart. Billing and an authenticated
manager portal are subsequent work, not simulated here.

## Regression fixes (October 27, 2026)

Malformed message bodies return 400 and unexpected route failures return a generic
500 without terminating the server. Direct mail verifies a confirmed Google VT
identity with Supabase on the server; the form email must match that identity.
The client includes its session token; missing/invalid verification falls back to
Gmail without sending through the site's mail account. IP limiting ignores
untrusted forwarded headers by default, and sender quotas use the verified user ID.

Manual per-person rent caps and whole-unit text budgets are applied to the same
floor plan. Cards and map pins use that final plan set. Contact history stores
transport and outcome separately, distinguishes submitted email from opened drafts,
and migrates the previous duplicate Text entries. Provider acceptance does not
claim inbox delivery, and a student copy is claimed only when its send succeeded.

`npm test` includes real HTTP crash-regression checks, simulated identity/mail
failures, spoofed-IP checks, real-catalog budget matching, client contact actions
and operator CLI tests against a temporary persistent directory. Tests never send
real property messages. Live Supabase/OAuth, mailbox delivery and deployment still
require their actual configured services.

### Contact flow decision (October 30, 2026)

Property inquiries always open a prefilled Gmail compose window. Students review and press Send in Gmail. The site does not request Gmail permissions, read inboxes, or send property inquiries through its server. No Resend or Supabase setup is needed for contacting properties. Contact history tracks draft openings, not delivery. The legacy server mail route is disabled; it returns 410 even if old mail credentials exist.

### Independent branding (October 30, 2026)

The visible product name is now Blacksburg Housing, with an original house icon in place of the mascot. University references remain only where descriptive or explanatory (location, student eligibility, account requirements, and non-affiliation). Existing saved-data keys and internal component names are preserved to avoid losing browser data. Listing photos are unchanged. This branding change is not a trademark clearance or a license for listing content.

## Preview hosting

The first hosted check uses a free Node web service with no disk. It can sleep
when idle, and aggregate sponsorship counts reset across restarts/redeploys.
Browser-local saved places and contact history are unaffected. The existing
`render.yaml` describes the optional persistent-disk setup for paid sponsorship
operations; no paid campaigns should depend on free-service counters.

Build/check command: `npm test && npm run check:catalog`. Start: `npm start`.
Set `HOST=0.0.0.0`, `NODE_VERSION=22`, `NODE_ENV=production`; the platform assigns `PORT`.
HTTP health endpoint: `/healthz`. Public support address: `SUPPORT_EMAIL` when ready.
No scraper or periodic job runs on the web service. Catalog refresh stays on demand.

The photo pipeline keeps the original signed source URLs as fallbacks when
enlarged versions fail. Selected floor-plan images take priority over generic
bedroom drawings. Basic asset checks are not a guarantee of future third-party
CDN availability.
