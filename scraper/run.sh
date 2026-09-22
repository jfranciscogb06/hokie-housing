#!/usr/bin/env bash
# One-shot scrape. Creates the venv on first use, then runs scrape.py with any args you pass.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "setting up venv…"; python3 -m venv .venv
  .venv/bin/pip install --quiet -r requirements.txt
fi
exec .venv/bin/python scrape.py "$@"
