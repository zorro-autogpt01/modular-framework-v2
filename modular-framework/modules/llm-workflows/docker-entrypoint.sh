#!/bin/sh
set -eu

echo "[entrypoint] starting…"

# Optional: allow a startup delay if you want to exec into the container first
: "${STARTUP_DELAY:=0}"
if [ "$STARTUP_DELAY" -gt 0 ]; then
  echo "[entrypoint] delaying startup for ${STARTUP_DELAY}s"
  sleep "$STARTUP_DELAY"
fi

# Ensure micromatch is present (band-aid so the app won’t crash)
if ! node -e "require.resolve('micromatch')" >/dev/null 2>&1; then
  echo "[entrypoint] micromatch not found, installing…"
  npm install micromatch@^4 --no-audit --no-fund || true
fi

# Double-check in case npm failed due to a transient issue
i=0
until node -e "require.resolve('micromatch')" >/dev/null 2>&1; do
  i=$((i+1))
  if [ $i -ge 3 ]; then
    echo "[entrypoint] micromatch still missing after retries; starting anyway."
    break
  fi
  echo "[entrypoint] retrying install ($i/3)…"
  npm install micromatch@^4 --no-audit --no-fund || true
  sleep 2
done

echo "[entrypoint] launching server"
exec node server/index.js