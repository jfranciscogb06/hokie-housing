#!/usr/bin/env bash
# Copy the site + data + photos + scraper into a clean folder (default: ~/Downloads/hokie-housing).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/hokie-housing}"
mkdir -p "$DEST"
cp "$SRC/hokie.html" "$DEST/index.html"
rsync -a --delete --exclude 'full_run.out' "$SRC/data/" "$DEST/data/"
rsync -a --delete "$SRC/photos/" "$DEST/photos/"
rsync -a --delete --exclude '.venv' --exclude '.chrome-profile*' --exclude '__pycache__' "$SRC/scraper/" "$DEST/scraper/"
echo "packaged to $DEST"; du -sh "$DEST"/{index.html,data,photos,scraper} 2>/dev/null
