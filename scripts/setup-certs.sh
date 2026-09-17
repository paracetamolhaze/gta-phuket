#!/usr/bin/env bash
# Creates a trusted localhost certificate for Twitch Local Test.
#
#   bash scripts/setup-certs.sh
#
# The Windows equivalent is scripts/setup-certs.ps1; use that one from
# PowerShell so mkcert installs its CA into the Windows trust store rather than
# into a WSL/Git-Bash one the browser never consults.
#
# Twitch frames the extension from https://localhost:8080/, and a browser will
# not frame a page whose certificate it does not trust — there is no "proceed
# anyway" for an iframe. mkcert issues certificates from a CA it installs
# locally, which is what makes them trusted.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cert_dir="$root/certs"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed."
  echo
  echo "  macOS:   brew install mkcert nss"
  echo "  Linux:   see https://github.com/FiloSottile/mkcert#installation"
  echo "  Windows: use scripts/setup-certs.ps1 instead"
  exit 1
fi

mkdir -p "$cert_dir"

echo "Installing the mkcert local CA..."
mkcert -install

echo "Issuing the certificate for localhost..."
(cd "$cert_dir" && mkcert -key-file localhost-key.pem -cert-file localhost.pem localhost 127.0.0.1 ::1)

echo
echo "Done:"
echo "  $cert_dir/localhost.pem"
echo "  $cert_dir/localhost-key.pem"
echo
echo "Start the stack, then open https://localhost:8080/video_overlay.html"
echo "  docker compose up -d --build"
