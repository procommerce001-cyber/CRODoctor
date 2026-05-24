#!/bin/bash
# Start API (:3000) and web (:3001).
# Idempotent: skips any service already listening on its port.
# Ctrl-C only stops what THIS invocation started — pre-existing processes survive.
#
# IMPORTANT: Run this from a persistent terminal window (not a temporary session).
# Processes die when their terminal is closed. Keep the window open while working.

ROOT="$(cd "$(dirname "$0")" && pwd)"

port_in_use() { lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

STARTED_PIDS=()

cleanup() {
  echo ""
  echo "Stopping services started by this session…"
  for pid in "${STARTED_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ── API :3000 ──────────────────────────────────────────────────────────────
if port_in_use 3000; then
  echo "[api] Already running on :3000 ✓"
else
  echo "[api] Starting on :3000"
  (cd "$ROOT/api" && npm run dev 2>&1 | sed -e 's/^/[api] /') &
  STARTED_PIDS+=($!)
fi

# ── Web :3001 ──────────────────────────────────────────────────────────────
if port_in_use 3001; then
  echo "[web] Already running on :3001 ✓"
else
  echo "[web] Starting on :3001"
  (cd "$ROOT/web" && npm run dev 2>&1 | sed -e 's/^/[web] /') &
  STARTED_PIDS+=($!)
fi

echo ""
echo "  Dashboard → http://localhost:3001/dashboard"
echo "  Press Ctrl-C to stop services started by this session."
echo ""

wait
