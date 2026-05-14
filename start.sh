#!/bin/sh
set -e
echo "[start.sh] Downloading latest bundle from GitHub..."
curl -fsSL -o /app/dist/index.mjs \
  "https://raw.githubusercontent.com/gblinproject/base-heartbeat-bo/main/dist/index.mjs"
echo "[start.sh] Bundle downloaded. Starting bot..."
exec node /app/dist/index.mjs
