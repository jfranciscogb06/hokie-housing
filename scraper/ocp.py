"""
Access layer for offcampus.vt.edu — Virginia Tech's official off-campus housing
portal, run by Apartments.com/CoStar behind Akamai Bot Manager.

How we get past the bot wall
----------------------------
Akamai fingerprints the TLS handshake and returns a flat 403 to anything that
doesn't look like a real browser: curl, requests, Playwright's Chromium and
Chrome's headless mode all bounce within ~2s. Two things get through:

  1. curl_cffi impersonating Chrome's exact TLS/HTTP2 fingerprint. No browser,
     runs anywhere Python runs (Render, a free VM, GitHub Actions). DEFAULT.
  2. A real, visible Google Chrome launched without the automation flag
     (Playwright, channel="chrome"). Kept as a fallback (`--browser`) in case
     Akamai tightens the TLS check later. Needs a desktop session.

Why we don't parse HTML
-----------------------
Every page embeds an Angular transfer-state blob, <script id="ocp-state">, that
caches the page's own backend (/bff/...) responses. The search page carries all
40 placards (photos, price, coordinates, lastUpdated); the property page carries
the full listing record (floor plans, amenities, walk time to campus, reviews).
We just read that JSON.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = "https://offcampus.vt.edu"
PROFILE_DIR = Path(__file__).parent / ".chrome-profile"

# Apartments.com CDN size codes (media.imageOptions on a property record).
# Template: https://images1.apartments.com/i2/<key>/{options}/image.jpg
IMG_FULL = "116"   # 2048x2048 box
IMG_LARGE = "112"  # 1880x900

# Landlord-uploaded photos live on a thumbor server. The signed URLs the site
# hands out are locked to 660x440, but the server also accepts unsigned
# ("unsafe") requests, which lets us ask for a proper 1600px JPEG.
_OCP_IMG = re.compile(r"^(?:https?:)?//img\.offcampusimages\.com/[^/]+/[^/]+/(?:[^/]+/)*images/([A-Za-z0-9_-]+\.\w+)$")

_ESC = {"&q;": '"', "&a;": "&", "&s;": "'", "&l;": "<", "&g;": ">"}
_STATE_RE = re.compile(r'<script id="ocp-state" type="application/json">(.*?)</script>', re.S)


def full_size_url(src: str) -> str:
    """Turn any photo URL the site gives us into its best-quality variant."""
    if src.startswith("//"):
        src = "https:" + src
    if "{options}" in src:
        return src.replace("{options}", IMG_FULL)
    m = re.match(r"^(https://images1\.apartments\.com/i2/[A-Za-z0-9_-]+/)\d{3}(/image\.\w+.*)$", src)
    if m:
        return f"{m.group(1)}{IMG_FULL}{m.group(2)}"
    m = _OCP_IMG.match(src)
    if m:
        return f"https://img.offcampusimages.com/unsafe/1600x0/filters:quality(82):format(jpeg)/images/{m.group(1)}"
    return src


def image_key(url: str) -> str:
    """Stable id for a photo regardless of which size variant we were given."""
    m = re.search(r"/i2/([A-Za-z0-9_-]+)/", url)
    if m:
        return "apt_" + m.group(1)
    m = re.search(r"/images/([A-Za-z0-9_-]+)\.\w+$", url)
    if m:
        return "ocp_" + m.group(1)
    return "u_" + re.sub(r"[^A-Za-z0-9]", "", url)[-40:]


def _unescape(body: str) -> str:
    for k, v in _ESC.items():
        body = body.replace(k, v)
    return body


def parse_state(raw: str) -> dict:
    """ocp-state blob -> {decoded bff url: parsed body}."""
    st = json.loads(raw)
    out = {}
    for v in st.values():
        if isinstance(v, dict) and "url" in v and "body" in v:
            try:
                url = base64.b64decode(v["url"]).decode("utf-8", "replace")
            except Exception:
                continue
            body = v["body"]
            if isinstance(body, str):
                try:
                    body = json.loads(_unescape(body))
                except json.JSONDecodeError:
                    pass
            out[url] = body
    return out


def _find(state: dict, needle: str):
    for url, body in state.items():
        if needle in url:
            return body
    return None


class _Base:
    """Shared page-level API on top of a transport that returns page HTML."""

    def __init__(self, delay: float = 1.0, log=print):
        self.delay = delay
        self.log = log
        self._last = 0.0

    def _throttle(self):
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def _html(self, path: str) -> str:  # implemented by transports
        raise NotImplementedError

    def _state(self, path: str, retries: int = 3) -> dict:
        for attempt in range(retries):
            self._throttle()
            try:
                html = self._html(path)
            except Blocked as e:
                back = 8 * (attempt + 1)
                self.log(f"  {e} on {path} — backing off {back}s")
                time.sleep(back)
                continue
            m = _STATE_RE.search(html)
            if not m:
                raise RuntimeError(f"no ocp-state on {path}")
            return parse_state(m.group(1))
        raise Blocked(f"gave up on {path} after {retries} attempts")

    def search_page(self, n: int) -> dict:
        path = "/housing" if n == 1 else f"/housing/page-{n}"
        body = _find(self._state(path), "/bff/listing/search/")
        if not body:
            raise RuntimeError(f"no search blob on page {n}")
        return body["data"]

    def iter_search(self, max_pages: int | None = None):
        first = self.search_page(1)
        total = first["metadata"]["totalPages"]
        self.log(f"catalog: {first['metadata']['totalResults']} results, {total} pages")
        yield 1, first
        for n in range(2, total + 1):
            if max_pages and n > max_pages:
                break
            yield n, self.search_page(n)

    def listing(self, site_id: str, profile_url: str) -> dict:
        body = _find(self._state(profile_url), f"/bff/listing/{site_id}?")
        if not body:
            raise RuntimeError(f"no listing blob for {site_id}")
        return body["data"]

    def fetch_image(self, url: str) -> bytes | None:
        raise NotImplementedError


class Blocked(RuntimeError):
    pass


class HTTP(_Base):
    """curl_cffi transport — Chrome TLS fingerprint, no browser. Default."""

    def __init__(self, impersonate: str = "chrome136", **kw):
        super().__init__(**kw)
        self.impersonate = impersonate
        self.s = None
        self.reset()

    def reset(self):
        """Fresh session (new connections + DNS) — used after a failure streak."""
        from curl_cffi import requests as cffi

        if self.s is not None:
            try:
                self.s.close()
            except Exception:
                pass
        self.s = cffi.Session(impersonate=self.impersonate)
        self.s.headers.update({"Accept-Language": "en-US,en;q=0.9"})

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.s.close()

    def _html(self, path: str) -> str:
        url = path if path.startswith("http") else BASE + path
        r = self.s.get(url, timeout=(10, 30))
        if r.status_code == 403:
            raise Blocked("403")
        if r.status_code != 200:
            raise RuntimeError(f"{r.status_code} on {path}")
        return r.text

    def fetch_image(self, url: str) -> bytes | None:
        url = full_size_url(url)
        try:
            # (connect, read) — a single hung CDN request once stalled a run for 17 minutes
            r = self.s.get(url, headers={"Referer": BASE + "/", "Accept": "image/jpeg,image/png,image/*;q=0.8"}, timeout=(10, 25))
        except Exception as e:
            self.log(f"  image error {url[:90]}: {e}")
            return None
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
            self.log(f"  image {r.status_code} {url[:90]}")
            return None
        return r.content


class Browser(_Base):
    """Real headed Google Chrome via Playwright. Fallback if HTTP starts 403ing."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self._pw = self.ctx = self.page = None

    def __enter__(self):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self.ctx = self._pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            channel="chrome",
            headless=False,
            args=["--disable-blink-features=AutomationControlled", "--window-size=1280,900"],
            ignore_default_args=["--enable-automation"],
            locale="en-US",
            viewport={"width": 1280, "height": 900},
        )
        self.page = self.ctx.new_page()
        if sys.platform == "darwin":
            # macOS won't let a window sit off-screen, so hide the process (like Cmd+H).
            time.sleep(0.8)
            subprocess.run(["osascript", "-e", 'tell application "System Events" to set visible of process "Google Chrome" to false'], capture_output=True, timeout=10)
        return self

    def __exit__(self, *exc):
        try:
            self.ctx.close()
        finally:
            self._pw.stop()

    def reset(self):
        pass

    def _html(self, path: str) -> str:
        from playwright.sync_api import TimeoutError as PWTimeout

        url = path if path.startswith("http") else BASE + path
        try:
            resp = self.page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except PWTimeout:
            raise RuntimeError(f"timeout on {path}")
        if resp.status == 403:
            raise Blocked("403")
        if resp.status != 200:
            raise RuntimeError(f"{resp.status} on {path}")
        return self.page.content()

    def fetch_image(self, url: str) -> bytes | None:
        url = full_size_url(url)
        try:
            r = self.ctx.request.get(url, headers={"Referer": BASE + "/", "Accept": "image/jpeg,image/png,image/*;q=0.8"}, timeout=40000)
        except Exception as e:
            self.log(f"  image error {url[:90]}: {e}")
            return None
        if r.status != 200 or not r.headers.get("content-type", "").startswith("image/"):
            self.log(f"  image {r.status} {url[:90]}")
            return None
        return r.body()


def open_client(browser: bool = False, **kw):
    return Browser(**kw) if browser else HTTP(**kw)
