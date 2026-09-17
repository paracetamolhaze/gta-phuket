#!/bin/sh
# Guarantees that the dev server can always come up on https://localhost:8080.
#
# The real certificate is the one mkcert issues on the host into ./certs — that
# is the only kind Twitch Local Test can use, because a browser will not frame a
# page whose certificate it does not trust.
#
# When it is missing we still start HTTPS, with a throwaway self-signed
# certificate generated here, so the URL scheme and port never change and the
# pages are reachable after clicking through the browser warning. Twitch Local
# Test will not work in that state, and the log says so.
set -e

MOUNTED_CERT=/app/certs/localhost.pem
MOUNTED_KEY=/app/certs/localhost-key.pem

if [ -f "$MOUNTED_CERT" ] && [ -f "$MOUNTED_KEY" ]; then
  echo "[web] using the trusted certificate from ./certs — Twitch Local Test is ready"
else
  FALLBACK=/tmp/dev-certs
  mkdir -p "$FALLBACK"
  if [ ! -f "$FALLBACK/localhost.pem" ]; then
    echo "[web] no mkcert certificate found — generating a self-signed stand-in"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "$FALLBACK/localhost-key.pem" \
      -out "$FALLBACK/localhost.pem" \
      -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
      >/dev/null 2>&1
  fi
  export DEV_CERT_DIR="$FALLBACK"
  echo "[web] ------------------------------------------------------------------"
  echo "[web] HTTPS is up on 8080 with a SELF-SIGNED certificate."
  echo "[web] The browser will warn, and Twitch Local Test will REFUSE to frame it."
  echo "[web] Run this once on the host, then recreate this container:"
  echo "[web]     powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1"
  echo "[web]     docker compose up -d --force-recreate web"
  echo "[web] ------------------------------------------------------------------"
fi

exec "$@"
