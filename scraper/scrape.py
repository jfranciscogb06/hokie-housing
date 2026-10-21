#!/usr/bin/env python3
"""
Hokie Housing scraper — pulls the full VT off-campus catalog from offcampus.vt.edu
and writes what the website reads.

    python scrape.py                  # incremental: catalog + changed listings + missing photos
    python scrape.py --details all    # re-fetch every listing's detail page
    python scrape.py --pages 2 --radius 2 --photos 4   # quick dev run
    python scrape.py --browser        # fall back to a real Chrome if HTTP gets 403s

Outputs (relative to the site root, one level up from this file):
    data/listings.js         window.HOKIE_LISTINGS = [...]  <- the site loads this
    data/listings.json       same data, plain JSON
    data/changes/<date>.json what changed since the last run (new / gone / price moves)
    data/raw/placards.json   last catalog crawl, keyed by siteId
    data/raw/details/*.json  full listing records (cached until lastUpdated changes)
    data/amenities.json      amenity id -> name, learned from detail pages
    photos/<siteId>/N.jpg    downloaded photos, 1600px max
    photos/manifest.json     which photos we have for each listing
    data/scrape.log
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from eligibility import resolve_audience

from PIL import Image, ImageOps

from ocp import BASE, Blocked, image_key, open_client, full_size_url
import bt

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
DETAILS = RAW / "details"
PHOTOS = ROOT / "photos"
CHANGES = DATA / "changes"

VT = (37.2284, -80.4234)  # Burruss Hall
BT_STOPS: list[dict] = []
PHOTO_MAX_W = 1600
PHOTO_QUALITY = 82

_log_file = None


def log(msg: str):
    line = f"{datetime.now().strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    if _log_file:
        _log_file.write(line + "\n")
        _log_file.flush()


def jload(p: Path, default):
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def jdump(p: Path, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1))


def g(o, *ks, default=None):
    for k in ks:
        if not isinstance(o, dict):
            return default
        o = o.get(k)
    return default if o is None else o


# ---------------------------------------------------------------- catalog
def crawl_catalog(client, max_pages) -> tuple[dict[str, dict], dict[str, dict]]:
    """Placards + pins from the search pages, each keyed by siteId.

    The portal randomizes result order per request (a `seed` in the search call), so
    paging is leaky: 17 pages x 40 cards yields ~450 unique listings with ~200 repeats
    and ~200 never shown. `pins` is the complete id+coordinate list, so it is the master
    set; anything it has that the pages didn't show gets fetched by id (see orphans)."""
    placards, pins = {}, {}
    for n, data in client.iter_search(max_pages):
        for p in data["placards"]:
            placards.setdefault(p["siteId"], p)
        for q in data.get("pins") or []:
            pins.setdefault(q["siteId"], q)
        log(f"page {n}: {len(data['placards'])} placards, {len(placards)} unique so far, {len(pins)} pins")
    return placards, pins


def placard_from_detail(site_id: str, d: dict) -> dict:
    """Synthesize the search-card shape from a full listing record (for pin-only listings)."""
    fs = d.get("floorPlanSummary") or {}
    return {
        "siteId": site_id,
        "name": d.get("name") or d.get("seoName") or "",
        "profileUrl": d.get("profileUrl") or f"/housing/property/x/{site_id}",
        "lastUpdated": d.get("lastUpdated"),
        "isSublet": d.get("isSublet"),
        "isSharedSpace": d.get("isSharedSpace"),
        "hideAddress": d.get("hideAddress"),
        "geography": d.get("geography") or {},
        "floorPlanSummary": {"matching": {"price": fs.get("price"), "beds": fs.get("bedrooms")}, "hasPerBedPricing": fs.get("hasPerBedPricing")},
        "leads": d.get("leads") or {},
        "media": d.get("media") or {},
        "mediaCollection": d.get("mediaCollection") or [],
        "amenityIds": d.get("amenityIds") or [],
        "standardLeaseTerm": d.get("standardLeaseTerm"),
        "adLevel": d.get("adLevel"),
        "ratingStars": d.get("ratingStars") or {},
        "_fromDetail": True,
    }


def miles_to_vt(p) -> float | None:
    """Straight-line miles to Burruss from the listing's coordinates. The portal's own
    distance field is only a fallback: it uses 200 as an "unknown" sentinel (Terrace View
    reports 200 mi) and is measured to a different campus point."""
    lat, lng = g(p, "geography", "latitude"), g(p, "geography", "longitude")
    if lat is not None and lng is not None:
        dy = (lat - VT[0]) * 69.0   # flat-earth approximation is fine at this scale
        dx = (lng - VT[1]) * 54.9
        return (dx * dx + dy * dy) ** 0.5
    d = g(p, "geography", "targetCollege", "distance")
    return float(d) if d is not None and d < 200 else None


# ---------------------------------------------------------------- details
def needs_detail(site_id: str, placard: dict, cached: dict | None, mode: str) -> bool:
    if mode == "none":
        return False
    if mode == "all" or cached is None:
        return True
    return cached.get("lastUpdated") != placard.get("lastUpdated")


def learn_amenities(detail: dict, amenities: dict[str, str]):
    for grp in detail.get("amenityGroups") or []:
        for it in grp.get("items") or []:
            if it.get("id") is not None and it.get("name"):
                amenities[str(it["id"])] = it["name"]


# ---------------------------------------------------------------- photos
def photo_sources(placard: dict, detail: dict | None) -> list[str]:
    """Ordered photo URLs; first one is what the site shows as the main photo."""
    srcs = []
    if detail:
        srcs += [im["source"] for im in g(detail, "media", "images", default=[]) if im.get("source")]
    if not srcs:
        srcs += [m["source"] for m in placard.get("mediaCollection") or [] if m.get("source") and m.get("type") in ("Image", 2, None)]
    if not srcs:
        main = g(placard, "media", "mainPhoto", "source")
        if main:
            srcs.append(main)
    seen, out = set(), []
    for s in srcs:
        k = image_key(s)
        if k not in seen:
            seen.add(k)
            out.append(s)
    return out


_BEDS_CAP = re.compile(r"(?<!\d)(\d)\s*(?:br\b|bed|bd\b|x\s*\d)", re.I)


def beds_in_caption(caption: str | None) -> int | None:
    m = _BEDS_CAP.search(caption or "")
    return int(m.group(1)) if m else None


def photo_groups(placard: dict, detail: dict | None) -> dict[str, list[str]]:
    """Extra photo sets beyond the main gallery, keyed by tag:
       beds<N>  photos whose caption names an N-bedroom unit (rare but gold: "4BR,4BA - 4x4C")
       plan<N>  the floor-plan drawing for the first N-bedroom plan"""
    groups: dict[str, list[str]] = {}
    if not detail:
        return groups
    for m in detail.get("mediaCollection") or []:
        if m.get("type") == 2 and m.get("source"):
            b = beds_in_caption(m.get("caption"))
            if b:
                groups.setdefault(f"beds{b}", []).append(m["source"])
    for i, fp in enumerate(detail.get("floorPlans") or []):
        src = g(fp, "fpImage2D", "source")
        b = fp.get("beds")
        if not src or b is None:
            continue
        if f"plan{b}" not in groups:
            groups[f"plan{b}"] = [src]           # representative drawing per bed count
        groups[f"planid_{fp.get('id') or fp.get('unitKey') or i}"] = [src]  # each plan's own drawing
    return groups


def save_photo(raw: bytes, dest: Path) -> tuple[int, int] | None:
    try:
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        return None
    if im.width < 500 or im.height < 300:
        if not dest.name.startswith("plan"):
            return None  # thumbnail-sized junk, skip
    if im.width > PHOTO_MAX_W:
        im = im.resize((PHOTO_MAX_W, round(im.height * PHOTO_MAX_W / im.width)), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "JPEG", quality=PHOTO_QUALITY, optimize=True, progressive=True)
    return im.size


class NetworkDown(RuntimeError):
    pass


class _Streak:
    """Tracks consecutive download failures; resets the session after a few, gives up
    on the photo phase after repeated resets (the run still publishes listings)."""
    fails = 0
    resets = 0

    def ok(self):
        self.fails = self.resets = 0

    def fail(self, client):
        self.fails += 1
        if self.fails < 6:
            return
        self.resets += 1
        if self.resets > 3:
            raise NetworkDown("photo downloads keep failing — network or CDN trouble")
        log(f"  {self.fails} downloads failed in a row — pausing 30s and opening a fresh session")
        time.sleep(30)
        client.reset()
        self.fails = 0


STREAK = _Streak()


def sync_photos(client, site_id: str, sources: list[str], manifest: dict, limit: int, tag: str = "main") -> list[str]:
    """Make the `tag` group of photos/<siteId>/ match the first `limit` sources.
    Returns site-relative paths. Other tags' entries are left untouched."""
    mine = [e for e in manifest.get(site_id, []) if e.get("tag", "main") == tag]
    others = [e for e in manifest.get(site_id, []) if e.get("tag", "main") != tag]
    have = {e["key"]: e for e in mine}
    want = sources[:limit]
    entries, n_new = [], 0
    for src in want:
        key = image_key(src)
        e = have.get(key)
        if e and (PHOTOS / e["file"]).exists():
            entries.append(e)
            continue
        raw = client.fetch_image(src)
        if not raw:
            STREAK.fail(client)
            continue
        STREAK.ok()
        prefix = "plan_" if tag.startswith("plan") else ""  # covers plan<N> and planid_<id>
        fname = f"{site_id}/{prefix}{hashlib.sha1(key.encode()).hexdigest()[:10]}.jpg"
        size = save_photo(raw, PHOTOS / fname)
        if not size:
            continue
        entries.append({"key": key, "file": fname, "w": size[0], "h": size[1], "src": src, "tag": tag})
        n_new += 1
        time.sleep(0.15)
    # prune photos that fell out of the top-N (never because a download failed)
    wanted_keys = {image_key(s) for s in want}
    keep = {e["file"] for e in entries}
    for e in mine:
        if e["key"] not in wanted_keys and e["file"] not in keep:
            (PHOTOS / e["file"]).unlink(missing_ok=True)
        elif e["file"] not in keep and (PHOTOS / e["file"]).exists():
            entries.append(e)  # download failed this time; keep what we had
    for e in entries:
        e["tag"] = tag
    manifest[site_id] = others + entries
    if n_new:
        log(f"  {site_id}: {n_new} new {tag} photo(s), {len(entries)} in group")
    return ["photos/" + e["file"] for e in entries]


def manifest_paths(manifest: dict, site_id: str, tag: str = "main") -> list[str]:
    return ["photos/" + e["file"] for e in manifest.get(site_id, []) if e.get("tag", "main") == tag and (PHOTOS / e["file"]).exists()]


def add_photo_fallbacks(rec: dict, entries: list[dict], sources: list[str], limit: int = 8):
    """Match CDN fallbacks by local path, including bedroom shots and floor plans."""
    fallbacks = {"photos/" + e["file"]: full_size_url(e["src"]) for e in entries if e.get("src")}
    rec["photoFallbacks"] = fallbacks
    if not rec["photos"]:
        rec["photos"] = [full_size_url(src) for src in sources[:limit or 8]]
    rec["photosRemote"] = [fallbacks.get(path, path if path.startswith("https://") else None) for path in rec["photos"]]


# ---------------------------------------------------------------- app shape
def _months(term: str | None) -> int:
    m = re.search(r"(\d+)\s*month", term or "", re.I)
    return int(m.group(1)) if m else 12


def _gradient(site_id: str) -> str:
    h = int(hashlib.md5(site_id.encode()).hexdigest()[:6], 16)
    return f"linear-gradient(135deg, hsl({h % 360},38%,42%), hsl({(h // 360) % 360},45%,62%))"


def to_app(site_id: str, p: dict, d: dict | None, amenities: dict[str, str], photos: list[str], extra: dict[str, list[str]] | None = None) -> dict:
    """Map a placard (+ optional detail record) onto the shape hokie.html renders."""
    d = d or {}
    names = {amenities.get(str(a), "") for a in p.get("amenityIds") or []}
    for grp in d.get("amenityGroups") or []:
        names.update(it.get("name", "") for it in grp.get("items") or [])
    names.discard("")
    lname = {n.lower() for n in names}
    has = lambda *ws: any(any(w in n for w in ws) for n in lname)

    # Detail record has the full price/bed range; the search card only has the "matching" slice.
    price = g(d, "floorPlanSummary", "price") or g(p, "floorPlanSummary", "matching", "price") or {}
    beds = g(d, "floorPlanSummary", "bedrooms") or g(p, "floorPlanSummary", "matching", "beds") or {}
    baths = g(d, "floorPlanSummary", "bathrooms") or {}
    fps = d.get("floorPlans") or []
    if not baths and fps:
        bs = [f.get("baths") for f in fps if f.get("baths") is not None]
        baths = {"low": min(bs), "high": max(bs)} if bs else {}
    sqft = g(d, "floorPlanSummary", "squareFeet") or {}

    # One walk estimate for every listing so sorting is fair: straight-line to Burruss,
    # x1.3 for real streets, at 20 min/mile. The portal's own routed time runs ~3x
    # straight-line (it routes deep into campus), so it's kept only as walkRouted.
    vt = next((c for c in g(d, "pointsOfInterest", "colleges", default=[]) if "Virginia Tech" in (c.get("name") or "")), None)
    dist = miles_to_vt(p)
    walk = max(1, round(dist * 1.3 * 20)) if dist is not None else None
    drive = g(vt, "drive", "time") if vt else None
    if drive is None and dist is not None:
        drive = max(2, round(dist / 22 * 60 + 2))  # ~22 mph average around town, plus parking
    stop = bt.nearest_stop(BT_STOPS, geo_lat := g(p, "geography", "latitude"), g(p, "geography", "longitude"))

    reviews = [{"who": f"{r.get('author') or 'Renter'} · {r.get('source') or 'review'}", "stars": r.get("score") or 0, "text": r.get("snippet") or r.get("comments") or ""}
               for r in d.get("reviews") or [] if r.get("snippet") or r.get("comments")]
    rating = d.get("renterRating") or g(p, "ratingStars", "rating") or 0
    rating = round(float(rating), 1) if rating else 0

    geo = p.get("geography") or {}
    street = geo.get("streetAddress") or ""
    city, state, zipc = geo.get("cityName") or "", geo.get("stateCode") or "VA", geo.get("zipCode") or ""
    hidden = bool(p.get("hideAddress"))
    address = f"{city}, {state} {zipc}".strip() if hidden or not street else f"{street}, {city}, {state} {zipc}".strip()
    area = g(d, "geography", "neighborhoods", default=[{}])[0].get("name") if g(d, "geography", "neighborhoods") else None
    if not area or area.lower().startswith("wider area"):
        area = None  # portal's catch-all label; the city name reads better

    style = d.get("propertyStyle") or ("Sublease" if p.get("isSublet") else "")
    if not style:
        n = (p.get("name") or "").lower()
        style = "Townhouse" if "townhouse" in n or "townhome" in n else "House" if "house" in n or "home" in n else "Condo" if "condo" in n else "Duplex" if "duplex" in n else "Apartment"

    # The portal's hasPerBedPricing flag is unreliable (Hub is "not per bed" at $999 for a
    # 4-bed; Old Row is "per bed" at $2,898 for a 2-bed). Derive it from the numbers instead:
    # if splitting the rent across the bedrooms lands under $450/bed, it's already per-bed.
    lo, nb = price.get("low") or 0, beds.get("low") or 0
    per_bed = bool(nb >= 2 and lo and lo / nb < 450)
    # Second signal, for communities with several plans: if a bigger unit is priced at or
    # below a smaller one (Hub's 2x2 at $1,375 vs its 1x1 at $1,859) the numbers are per bed.
    by_beds = {}
    for fp in fps:
        if fp.get("beds") and fp.get("priceLow"):
            by_beds[fp["beds"]] = min(by_beds.get(fp["beds"], 9e9), fp["priceLow"])
    ks = sorted(by_beds)
    if any(by_beds[b2] <= by_beds[b1] for i, b1 in enumerate(ks) for b2 in ks[i + 1:]):
        per_bed = True

    pets_no = has("pets not allowed", "no pets")
    pets = (not pets_no) and (has("pets allowed", "cats allowed", "dogs allowed", "small dogs", "pet friendly") or bool(d.get("petAmenities")))
    # bus: the real nearest campus-serving BT stop (GTFS) wins; the landlord's "near bus stop" claim is a fallback
    bus = ", ".join(stop["routes"][:2]) if stop and stop["walkMin"] <= 12 else ("BT" if has("bus stop", "bus route", "shuttle") else "—")
    # who the landlord says the place is for ("Convenient For" on the portal)
    audience = {"undergrad": "Undergraduates" in names, "grad": "Graduate Students" in names, "faculty": "Faculty/Staff" in names} if any(x in names for x in ("Undergraduates", "Graduate Students", "Faculty/Staff")) else None
    audience, audience_evidence = resolve_audience(d.get("longDescription") or d.get("shortDescription") or "", audience)

    extra = extra or {}
    photos_by_beds = {t[4:]: v for t, v in extra.items() if t.startswith("beds") and v}
    plan_photos = {t[4:]: v[0] for t, v in extra.items() if t.startswith("plan") and not t.startswith("planid_") and v}
    plan_by_id = {t[7:]: v[0] for t, v in extra.items() if t.startswith("planid_") and v}
    # 3D tours (Matterport) are the one truly per-unit thing communities publish.
    tours = [{"beds": beds_in_caption(m.get("caption")), "caption": m.get("caption") or "3D tour", "url": m.get("source")}
             for m in d.get("mediaCollection") or [] if m.get("type") == 4 and m.get("source")]
    plans = [{
        "id": fp.get("id") or fp.get("unitKey") or str(i),
        "name": fp.get("name") or f"{fp.get('beds')} bed / {fp.get('baths')} bath",
        "beds": fp.get("beds"), "baths": fp.get("baths"),
        "price": fp.get("priceLow"), "priceHigh": fp.get("priceHigh"), "priceLabel": fp.get("priceRange"),
        "sqft": fp.get("squareFeet"),
        # status: AvailableNow | FutureDate | AvailableSoon | CallForAvailability | NotAvailable
        "status": fp.get("availability"), "availability": fp.get("availabilityDescription"),
        "availableDate": (fp.get("availableDate") or "")[:10] or None, "units": fp.get("unitsAvailable"),
        "image": plan_by_id.get(str(fp.get("id") or fp.get("unitKey") or i)) or plan_photos.get(str(fp.get("beds"))),
    } for i, fp in enumerate(fps) if fp.get("beds") is not None]

    return {
        "id": site_id,
        "name": p.get("name") or d.get("name") or street or "Listing",
        "type": style,
        "price": price.get("low") or 0,
        "priceHigh": price.get("high") or price.get("low") or 0,
        "priceLabel": price.get("formatted") or p.get("totalMonthlyPrice") or "",
        "perBed": per_bed,
        "beds": beds.get("low") if beds.get("low") is not None else 0,
        "bedsHigh": beds.get("high") if beds.get("high") is not None else beds.get("low") or 0,
        "baths": baths.get("low") if baths.get("low") is not None else 1,
        "sqft": sqft.get("low"),
        "walk": walk if walk is not None else 60,
        "walkRouted": g(vt, "walk", "time") if vt else None,
        "driveMin": drive,
        "busStop": stop,                  # {name, distMi, walkMin, routes} nearest campus-serving BT stop, or null
        "audience": audience,             # {undergrad, grad, faculty} booleans, or null if unstated
        "audienceEvidence": audience_evidence,
        "distanceMi": round(dist, 2) if dist is not None else None,
        "bus": bus,
        "lease": _months(p.get("standardLeaseTerm") or d.get("standardLeaseTerm")),
        "furnished": has("furnished"),
        "utilities": has("utilities included", "all utilities"),
        "pets": pets,
        "rating": rating,
        "reviews": len(reviews),
        "reviewsList": reviews,
        "verified": len(reviews) > 0,
        "area": area or city,
        "address": address,
        "lat": geo.get("latitude"),
        "lng": geo.get("longitude"),
        "img": _gradient(site_id),
        "photos": photos,
        "photosByBeds": photos_by_beds,   # {"4": [paths]} — photos captioned as that unit type
        "planPhotos": plan_photos,        # {"4": path} — floor-plan drawing for that bed count
        "plans": plans,
        "tours": tours,                   # [{beds, caption, url}] Matterport walkthroughs
        "amenities": sorted(n for n in names if n not in ("Undergraduates", "Graduate Students", "Faculty/Staff")),
        "desc": (d.get("longDescription") or d.get("shortDescription") or "").strip(),
        "featured": False,
        "sublet": bool(p.get("isSublet")),
        "shared": bool(p.get("isSharedSpace")),
        "availability": next((f.get("availabilityDescription") for f in fps if f.get("availabilityDescription")), None),
        "manager": g(d, "pmcInfo", "name"),
        "website": g(d, "siteTexts", "propertyWebsiteLink") or g(d, "pmcInfo", "websiteLink") or None,
        "phone": g(p, "leads", "phone", "formatted") or g(d, "leads", "phone", "formatted"),
        # The portal rarely exposes an email (its own contact button is login-gated);
        # agent-listed places sometimes carry one. Anything else falls back to CONTACT.inbox in the site.
        "email": g(d, "residentialListingAgent", "agentEmail") or g(d, "mlsData", "agentEmail") or None,
        "sourceUrl": BASE + (p.get("profileUrl") or ""),
        "lastUpdated": p.get("lastUpdated"),
    }


# ---------------------------------------------------------------- overview
def _median(xs):
    xs = sorted(x for x in xs if x)
    return xs[len(xs) // 2] if xs else None


def build_overview(l: dict, medians: dict) -> tuple[str, list[str], list[str]]:
    """A plain-English summary plus pros/cons, derived from the record (no LLM).
    `medians` = {beds: median per-bed-or-unit price for that bed count} for fair price calls."""
    pros, cons = [], []
    am = " ".join(l.get("amenities") or []).lower()
    stop = l.get("busStop")
    walk, drive = l.get("walk"), l.get("driveMin")
    nb = l.get("beds") or 0
    unit = "/bed" if l.get("perBed") else "/mo"

    if walk is not None and walk <= 15:
        pros.append(f"{walk}-min walk to campus")
    elif walk is not None and walk <= 25:
        pros.append(f"Walkable, about {walk} min to campus")
    if stop and stop["walkMin"] <= 5:
        pros.append(f"BT stop {stop['walkMin']} min away ({', '.join(stop['routes'][:3])})")
    elif stop and stop["walkMin"] <= 10:
        pros.append(f"Bus stop within a {stop['walkMin']}-min walk")
    if l.get("rating") and l.get("reviews", 0) >= 5 and l["rating"] >= 4.0:
        pros.append(f"Well reviewed: ★{l['rating']} from {l['reviews']} renters")
    community = [w for w, k in (("pool", "pool"), ("gym", "fitness"), ("study lounge", "study"), ("clubhouse", "clubhouse"), ("shuttle", "shuttle")) if k in am]
    if len(community) >= 2:
        pros.append("Community amenities: " + ", ".join(community))
    if "private bath" in am or "bath per bedroom" in am or (l.get("baths") and nb and l["baths"] >= nb and nb >= 2):
        pros.append("Private bathroom per bedroom")
    if "washer/dryer in unit" in am or "washer/dryer" in am:
        pros.append("In-unit washer/dryer")
    if l.get("furnished"):
        pros.append("Comes furnished")
    if l.get("utilities"):
        pros.append("Utilities included")
    if l.get("pets"):
        pros.append("Pet friendly")
    med = medians.get(nb)
    if med and l.get("price") and l["price"] <= med * 0.85:
        pros.append(f"Below-average rent for a {nb}-bed (typical ${med:,}{unit})")
    if l.get("availability") and "now" in l["availability"].lower() or any(p.get("status") == "AvailableNow" for p in l.get("plans") or []):
        pros.append("Units available now")

    if walk is not None and walk > 30 and not (stop and stop["walkMin"] <= 10):
        cons.append(f"Far from campus ({drive} min drive), so you'll want a car" if drive else "Far from campus, so you'll want a car")
    elif walk is not None and walk > 30:
        cons.append("Too far to walk, so plan on the bus")
    if not stop:
        cons.append("No BT stop within a 12-min walk")
    if l.get("pets") is False and ("no pets" in am or "pets not allowed" in am):
        cons.append("No pets")
    if l.get("rating") and l.get("reviews", 0) >= 3 and l["rating"] < 3.5:
        cons.append(f"Mixed reviews (★{l['rating']} from {l['reviews']})")
    if med and l.get("price") and l["price"] >= med * 1.2:
        cons.append(f"Pricier than most {nb}-beds (typical ${med:,}{unit})")
    if not l.get("furnished") and l.get("type") == "Apartment":
        cons.append("Unfurnished")
    if l.get("shared"):
        cons.append("Room in a shared unit; the landlord sets roommates")
    aud = l.get("audience") or {}
    if aud and aud.get("undergrad") is False:
        cons.append("Undergrads not allowed")
    if all(p.get("status") == "NotAvailable" for p in l.get("plans") or [None] if p):
        cons.append("Nothing available right now")
    elif not any(p.get("status") == "AvailableNow" for p in l.get("plans") or []) and l.get("plans"):
        soon = min((p.get("availableDate") for p in l["plans"] if p.get("availableDate")), default=None)
        cons.append(f"Earliest move-in {soon}" if soon else "Nothing available until next lease term")

    # One short line; the pros/cons carry the detail.
    if walk is not None and walk <= 20:
        how = f"{walk}-min walk to campus"
    elif stop and stop["walkMin"] <= 8:
        how = f"{stop['walkMin']} min to the {stop['routes'][0]} bus"
    elif drive:
        how = f"{drive}-min drive to campus"
    else:
        how = "a short drive to campus"
    price = f"from ${l['price']:,}{unit}" if l.get("price") else "call for pricing"
    text = f"{how} · {price}"
    return text, pros[:5], cons[:4]


# ---------------------------------------------------------------- diff
def diff(prev: list[dict], cur: list[dict]) -> dict:
    a = {l["id"]: l for l in prev}
    b = {l["id"]: l for l in cur}
    out = {"new": [], "removed": [], "priceChanges": [], "photoChanges": 0}
    for i, l in b.items():
        if i not in a:
            out["new"].append({"id": i, "name": l["name"], "price": l["price"], "url": l["sourceUrl"]})
        else:
            o = a[i]
            if o.get("price") != l.get("price"):
                out["priceChanges"].append({"id": i, "name": l["name"], "from": o.get("price"), "to": l.get("price"), "url": l["sourceUrl"]})
            if o.get("photos") != l.get("photos"):
                out["photoChanges"] += 1
    for i, l in a.items():
        if i not in b:
            out["removed"].append({"id": i, "name": l["name"], "price": l.get("price")})
    return out


# ---------------------------------------------------------------- main
def main():
    global _log_file
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pages", type=int, default=None, help="only crawl the first N search pages (dev)")
    ap.add_argument("--details", choices=["changed", "all", "none"], default="changed", help="which listings to open the detail page for (default: changed)")
    ap.add_argument("--max-details", type=int, default=None, help="cap detail fetches this run")
    ap.add_argument("--photos", type=int, default=8, help="photos per listing to keep (0 = skip photo sync)")
    ap.add_argument("--radius", type=float, default=8.0, help="only publish listings within N miles of campus")
    ap.add_argument("--browser", action="store_true", help="use a real Chrome window instead of curl_cffi")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between page loads")
    ap.add_argument("--remote-photos", action="store_true", help="don't download photos; publish CDN URLs (for server/CI runs)")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    _log_file = open(DATA / "scrape.log", "a")
    started = time.time()
    log(f"=== run start {datetime.now(timezone.utc).isoformat(timespec='seconds')} args={vars(args)}")

    global BT_STOPS
    BT_STOPS = bt.load_stops(DATA, log=log)
    amenities = jload(DATA / "amenities.json", {})
    manifest = jload(PHOTOS / "manifest.json", {})
    prev_listings = jload(DATA / "listings.json", {}).get("listings", [])

    try:
        with open_client(browser=args.browser, delay=args.delay, log=log) as client:
            placards, pins = crawl_catalog(client, args.pages)

            # Listings the randomized pages never showed: fetch by id, build the card from the record.
            orphans = [sid for sid, q in pins.items() if sid not in placards and (miles_to_vt(q) or 99) <= args.radius]
            n_orph = 0
            for sid in orphans:
                cached = jload(DETAILS / f"{sid}.json", None)
                fresh = cached and (time.time() - (cached.get("_fetchedAt") or 0)) < 7 * 86400
                if not fresh and args.details != "none":
                    if args.max_details is not None and n_orph >= args.max_details:
                        break
                    try:
                        cached = client.listing(sid, f"/housing/property/x/{sid}")
                    except Blocked:
                        raise
                    except Exception as e:
                        log(f"  orphan failed {sid}: {e}")
                        continue
                    cached["_fetchedAt"] = time.time()
                    jdump(DETAILS / f"{sid}.json", cached)
                    learn_amenities(cached, amenities)
                    n_orph += 1
                if cached:
                    placards[sid] = placard_from_detail(sid, cached)
            log(f"orphans: {len(orphans)} pin-only listings in range, {n_orph} fetched this run")
            jdump(RAW / "placards.json", placards)

            in_range = {sid: p for sid, p in placards.items() if (miles_to_vt(p) or 99) <= args.radius}
            log(f"{len(in_range)} of {len(placards)} listings within {args.radius} mi of campus")

            # details
            n_det = 0
            for sid, p in in_range.items():
                if p.get("_fromDetail"):
                    continue
                cached = jload(DETAILS / f"{sid}.json", None)
                if not needs_detail(sid, p, cached, args.details):
                    continue
                if args.max_details is not None and n_det >= args.max_details:
                    break
                try:
                    d = client.listing(sid, p["profileUrl"])
                except Blocked:
                    raise
                except Exception as e:
                    log(f"  detail failed {sid}: {e}")
                    continue
                d["lastUpdated"] = p.get("lastUpdated")
                d["_fetchedAt"] = time.time()
                jdump(DETAILS / f"{sid}.json", d)
                learn_amenities(d, amenities)
                n_det += 1
                if n_det % 25 == 0:
                    log(f"  details: {n_det} fetched")
                    jdump(DATA / "amenities.json", amenities)
            log(f"details: {n_det} fetched this run")
            jdump(DATA / "amenities.json", amenities)

            # photos + app records
            listings = []
            photos_on = args.photos > 0
            for sid, p in in_range.items():
                d = jload(DETAILS / f"{sid}.json", None)
                srcs = photo_sources(p, d)
                groups = photo_groups(p, d)
                extra: dict[str, list[str]] = {}
                if args.remote_photos:
                    # Server/CI runs: no 800MB photo folder; the site loads the CDN copies directly.
                    rec = to_app(sid, p, d, amenities, [full_size_url(x) for x in srcs[:args.photos or 8]],
                                 {tag: [full_size_url(x) for x in g[:4 if tag.startswith("beds") else 1]] for tag, g in groups.items()})
                    rec["photosRemote"] = list(rec["photos"])
                    rec["photoFallbacks"] = {}
                    listings.append(rec)
                    continue
                if photos_on:
                    try:
                        photos = sync_photos(client, sid, srcs, manifest, args.photos)
                        for tag, gsrcs in groups.items():
                            extra[tag] = sync_photos(client, sid, gsrcs, manifest, 4 if tag.startswith("beds") else 1, tag=tag)
                    except NetworkDown as e:
                        log(f"  {e} — skipping the rest of the photo phase; rerun later to fill in")
                        photos_on = False
                if not photos_on:
                    photos = manifest_paths(manifest, sid)
                    extra = {tag: manifest_paths(manifest, sid, tag) for tag in groups}
                rec = to_app(sid, p, d, amenities, photos, extra)
                # original CDN URLs, so the site still shows photos when photos/ isn't present (e.g. a fresh git clone)
                add_photo_fallbacks(rec, manifest.get(sid, []), srcs, args.photos)
                listings.append(rec)
    except Blocked as e:
        log(f"BLOCKED: {e}. Try again in a few minutes, or run with --browser.")
        jdump(PHOTOS / "manifest.json", manifest)
        sys.exit(2)
    finally:
        jdump(PHOTOS / "manifest.json", manifest)

    # overview + pros/cons need the whole set (price medians by bed count)
    medians = {}
    for nb in {l["beds"] for l in listings}:
        medians[nb] = _median([l["price"] for l in listings if l["beds"] == nb and l["price"]])
    for l in listings:
        l["overview"], l["pros"], l["cons"] = build_overview(l, medians)
    listings.sort(key=lambda l: (l["walk"], -(l["rating"] or 0)))
    meta = {"updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(listings), "source": BASE + "/housing", "radiusMi": args.radius}
    jdump(DATA / "listings.json", {"meta": meta, "listings": listings})
    js = f"window.HOKIE_META = {json.dumps(meta)};\nwindow.HOKIE_LISTINGS = {json.dumps(listings, ensure_ascii=False)};\n"
    (DATA / "listings.js").write_text(js)

    ch = diff(prev_listings, listings)
    ch["runAt"] = meta["updatedAt"]
    jdump(CHANGES / f"{datetime.now().strftime('%Y-%m-%d_%H%M')}.json", ch)
    n_photos = sum(len(v) for v in manifest.values())
    log(f"published {len(listings)} listings, {n_photos} photos on disk | new {len(ch['new'])}, removed {len(ch['removed'])}, price changes {len(ch['priceChanges'])} | {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
