# Creates a trusted localhost certificate for Twitch Local Test.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1
#
# Twitch Local Test loads the extension from https://localhost:8080/ inside an
# iframe. A self-signed certificate is not enough: the browser blocks a framed
# page whose certificate it does not trust, and you never even get the "proceed
# anyway" screen. mkcert solves this by installing its own CA into the Windows
# trust store, so certificates it issues are trusted like any other.
#
# Run once. The certificate is written to certs/ which is gitignored — the
# private key must never be committed.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $root 'certs'
$certFile = Join-Path $certDir 'localhost.pem'
$keyFile = Join-Path $certDir 'localhost-key.pem'

Write-Host ''
Write-Host 'GTA Phuket - local HTTPS certificate' -ForegroundColor Cyan
Write-Host ''

$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcert) {
    Write-Host 'mkcert is not installed.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Install it once, with either:'
    Write-Host '    winget install FiloSottile.mkcert'
    Write-Host '    choco install mkcert'
    Write-Host ''
    Write-Host 'Then open a NEW terminal and run this script again.'
    exit 1
}

if (-not (Test-Path $certDir)) {
    New-Item -ItemType Directory -Path $certDir | Out-Null
}

# Installs the local CA into the Windows trust store. Safe to run repeatedly;
# Windows may show a one-time certificate prompt - accept it.
Write-Host 'Installing the mkcert local CA (accept the Windows prompt if it appears)...'
& mkcert -install

Write-Host 'Issuing the certificate for localhost...'
Push-Location $certDir
try {
    & mkcert -key-file 'localhost-key.pem' -cert-file 'localhost.pem' localhost 127.0.0.1 ::1
}
finally {
    Pop-Location
}

if ((Test-Path $certFile) -and (Test-Path $keyFile)) {
    Write-Host ''
    Write-Host 'Done.' -ForegroundColor Green
    Write-Host "  $certFile"
    Write-Host "  $keyFile"
    Write-Host ''
    Write-Host 'Now start the stack and open https://localhost:8080/video_overlay.html'
    Write-Host '    docker compose up -d --build'
    Write-Host ''
    Write-Host 'If the containers were already running, recreate the web one so it'
    Write-Host 'picks the certificate up:'
    Write-Host '    docker compose up -d --force-recreate web'
}
else {
    Write-Host 'mkcert finished but the certificate files are missing.' -ForegroundColor Red
    exit 1
}
