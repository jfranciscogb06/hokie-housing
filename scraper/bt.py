"""
Blacksburg Transit stops, from the agency's public GTFS feed (via the Mobility
Database mirror). Gives each listing its nearest bus stop that actually serves
campus, the walk time to it, and which routes stop there.

Cached in data/raw/bt_gtfs.zip and data/bt_stops.json; refreshed weekly.
"""
from __future__ import annotations

import csv
import io
import json
import time
import zipfile
from pathlib import Path

GTFS_URL = "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-virginia-blacksburg-transit-gtfs-1189.zip?alt=media"
VT = (37.2284, -80.4234)          # Burruss Hall
CAMPUS_RADIUS_MI = 0.45           # a stop this close to Burruss counts as "on campus"
MAX_STOP_MI = 0.6                 # beyond this we say there's no usable stop
WALK_MIN_PER_MI = 20 * 1.3        # 3 mph with a street-routing fudge


def miles(a_lat, a_lon, b_lat, b_lon) -> float:
    dy = (a_lat - b_lat) * 69.0
    dx = (a_lon - b_lon) * 54.9
    return (dx * dx + dy * dy) ** 0.5


def _download(dest: Path, log) -> bytes | None:
    try:
        from curl_cffi import requests as cffi

        r = cffi.get(GTFS_URL, timeout=90)
        if r.status_code == 200 and r.content[:2] == b"PK":
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(r.content)
            return r.content
        log(f"  BT GTFS download failed: {r.status_code}")
    except Exception as e:
        log(f"  BT GTFS download error: {e}")
    return None


def load_stops(data_dir: Path, log=print, max_age_days: int = 7) -> list[dict]:
    """[{id, name, lat, lon, routes: [short names], campus: bool}] — only stops served
    by at least one route that also stops on campus."""
    out = data_dir / "bt_stops.json"
    zpath = data_dir / "raw" / "bt_gtfs.zip"
    fresh = out.exists() and (time.time() - out.stat().st_mtime) < max_age_days * 86400
    if fresh:
        return json.loads(out.read_text())
    raw = _download(zpath, log) or (zpath.read_bytes() if zpath.exists() else None)
    if not raw:
        return json.loads(out.read_text()) if out.exists() else []
    z = zipfile.ZipFile(io.BytesIO(raw))
    rd = lambda n: list(csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig")))
    stops = {s["stop_id"]: {"id": s["stop_id"], "name": s["stop_name"], "lat": float(s["stop_lat"]), "lon": float(s["stop_lon"])} for s in rd("stops.txt")}
    routes = {r["route_id"]: (r.get("route_short_name") or r["route_id"]) for r in rd("routes.txt")}
    trip_route = {t["trip_id"]: t["route_id"] for t in rd("trips.txt")}
    stop_routes: dict[str, set] = {}
    for st in rd("stop_times.txt"):
        rid = trip_route.get(st["trip_id"])
        if rid:
            stop_routes.setdefault(st["stop_id"], set()).add(rid)
    campus_routes = {rid for sid, rids in stop_routes.items() if sid in stops and miles(stops[sid]["lat"], stops[sid]["lon"], *VT) <= CAMPUS_RADIUS_MI for rid in rids}
    result = []
    for sid, s in stops.items():
        rids = stop_routes.get(sid, set()) & campus_routes
        if not rids:
            continue
        s["routes"] = sorted({routes[r] for r in rids})
        s["campus"] = miles(s["lat"], s["lon"], *VT) <= CAMPUS_RADIUS_MI
        result.append(s)
    out.write_text(json.dumps(result))
    log(f"BT: {len(result)} campus-serving stops across {len({r for s in result for r in s['routes']})} routes")
    return result


def nearest_stop(stops: list[dict], lat, lng) -> dict | None:
    """Nearest campus-serving stop within MAX_STOP_MI, with walk minutes and routes."""
    if lat is None or lng is None or not stops:
        return None
    best, bd = None, 9e9
    for s in stops:
        d = miles(lat, lng, s["lat"], s["lon"])
        if d < bd:
            best, bd = s, d
    if best is None or bd > MAX_STOP_MI:
        return None
    return {"name": best["name"], "distMi": round(bd, 2), "walkMin": max(1, round(bd * WALK_MIN_PER_MI)), "routes": best["routes"]}
