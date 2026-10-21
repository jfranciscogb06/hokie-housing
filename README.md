# Hokie Housing

Off-campus housing for Virginia Tech students: every listing near campus, real photos,
natural-language search, floor plans, bus stops, and a way to find other students
interested in the same place.

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

```bash
./scraper/run.sh          # ~3 min: re-crawls the portal, fetches what changed, commits nothing
```

See [scraper/README.md](scraper/README.md) for how it works and the options.

## Config (in `index.html`)

- `CONTACT.inbox` — where "Request info" emails go when a listing has no email.
- `BACKEND` — Supabase URL + anon key to share "I'm interested" across users (optional).

## Layout

```
index.html        the app UI
housing-search.js shared search schema, filters, and built-in parser
eligibility.js    description-based student restriction rules
api/search.js     server-side AI interpretation
server.js         local app/API server
data/listings.js  the catalog (generated)
scraper/          the pipeline (Python)
photos/           local photos (generated, git-ignored)
```

## Release status (October 5, 2026)

The current app is a prototype with a real saved catalog (533 listings, refreshed
September 21 at 8:05 PM Eastern). Sign-in, user posts, roommate matching, billing,
admin metrics, and moderation are simulated or local-only. It is not ready to
release as a functioning social marketplace.

Recommended first release: a public housing-search beta with real listings,
filters, maps, saved places on the current device, floor plans, and contact links.
Before publishing: remove the simulated account gate and demo commerce/social
flows; remove the remaining demo social flows;
resolve rent-unit inference; refresh and verify student restriction evidence;
verify the deployed site without local photos; and test mobile/keyboard flows.
Shared features require real authentication and owner-scoped database policies.

Request info now offers phone/property/original-listing links when no recipient
email exists. Opening an email is recorded as a draft, not confirmed delivery.

## Photo layout preference

Listing detail pages use the supplied Airbnb-style reference: one large image on
the left and a 2×2 grid on the right, narrow white gaps,
rounded outer corners, title above, and a Show all photos button at bottom right.
The top-right grid slot has equal side-by-side actions: **Show more photos** and
**View more on Google**, each with a single-line label. Smaller widths use
**More photos** / **Google images** so text stays readable. No subtitle or large
icons. Google opens Google Images in a new tab using property name and address.
The other three small slots display listing photos.
On mobile, show one large lead photo, the same full-gallery entry point, and
a separate View more on Google link below the image.
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

Use `npm start`. Campaigns are read from `sponsorships/campaigns.json` on the server
and managed with the local operator command. That file and the metrics are not
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
for 90 days in git-ignored `.local/sponsor-stats.json`, without raw visitor logs.
These basic counts are not unique visitors, a guarantee of leads, or audited ad
billing. The endpoint has a per-process abuse limit. A deployed version needs
persistent storage for campaign config and metrics; billing and an authenticated
manager portal are subsequent work, not simulated here.
