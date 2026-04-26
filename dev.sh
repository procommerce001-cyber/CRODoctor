#!/bin/bash
# Start API (port 3000) and web (port 3001) together.
# Ctrl-C stops both.

ROOT="$(cd "$(dirname "$0")" && pwd)"

trap 'echo ""; echo "Stopping…"; kill $(jobs -p) 2>/dev/null; wait; exit 0' INT TERM

echo "[api] Starting on :3000"
(cd "$ROOT/api" && npm run dev 2>&1 | sed -e 's/^/[api] /') &

echo "[web] Starting on :3001"
(cd "$ROOT/web" && npm run dev 2>&1 | sed -e 's/^/[web] /') &

wait
