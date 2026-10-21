#!/usr/bin/env bash
# Copy the site + data + photos + scraper into a separate, new folder.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?Usage: ./scraper/package.sh /path/to/new-folder}"
if [ -e "$DEST" ]; then
  echo "Destination already exists; choose a new folder to avoid overwriting files." >&2
  exit 1
fi
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
case "$DEST/" in "$SRC/"*)
  rmdir "$DEST"
  echo "Destination must be outside the source project." >&2
  exit 1 ;;
esac
cp "$SRC/index.html" "$DEST/index.html"
cp "$SRC/housing-search.js" "$SRC/eligibility.js" "$SRC/sponsorships.js" "$SRC/server.js" "$SRC/package.json" "$SRC/.env.example" "$DEST/"
rsync -a "$SRC/api/" "$DEST/api/"
rsync -a "$SRC/assets/" "$DEST/assets/"
rsync -a "$SRC/sponsorships/" "$DEST/sponsorships/"
rsync -a "$SRC/scripts/" "$DEST/scripts/"
rsync -a --delete --exclude 'full_run.out' "$SRC/data/" "$DEST/data/"
rsync -a --delete "$SRC/photos/" "$DEST/photos/"
rsync -a --delete --exclude '.venv' --exclude '.chrome-profile*' --exclude '__pycache__' "$SRC/scraper/" "$DEST/scraper/"
echo "packaged to $DEST"; du -sh "$DEST"/{index.html,data,photos,scraper} 2>/dev/null
