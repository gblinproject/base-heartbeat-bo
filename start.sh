#!/bin/sh
set -e
echo "[start.sh] Downloading latest bundle from GitHub (cache-busted)..."
curl -fsSL -H "Cache-Control: no-cache, no-store" -H "Pragma: no-cache" \
  -o /app/dist/index.mjs \
  "https://raw.githubusercontent.com/gblinproject/base-heartbeat-bo/main/dist/index.mjs?t=$(date +%s)"
echo "[start.sh] Bundle downloaded. Token check:"
grep -m1 "var TOKEN_ADDRESS" /app/dist/index.mjs || true
echo "[start.sh] Starting bot..."
exec node /app/dist/index.mjs
