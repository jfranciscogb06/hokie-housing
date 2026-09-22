# Hokie Housing

Off-campus housing for Virginia Tech students: every listing near campus, real photos,
natural-language search, floor plans, bus stops, and a way to find other students
interested in the same place.

## Run it

```bash
python3 -m http.server 8788
# open http://localhost:8788
```

That's it — `index.html` is the whole app (React via CDN, no build step). It reads
`data/listings.js`, which is checked in.

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
index.html        the app
data/listings.js  the catalog (generated)
scraper/          the pipeline (Python)
photos/           local photos (generated, git-ignored)
```
