#!/usr/bin/env bash
# Pre-build: copies host resources into .build/ for the Docker build context.
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)/.build"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "$SSL_CERT_FILE" ]; then
  cp "$SSL_CERT_FILE" "$BUILD_DIR/ca-certificates.crt"
  echo "[prepare-build] Copied CA bundle → .build/ca-certificates.crt"
elif [ -n "${SSL_CERT_FILE:-}" ]; then
  echo "[prepare-build] SSL_CERT_FILE=$SSL_CERT_FILE not found — skipping" >&2
else
  echo "[prepare-build] No SSL_CERT_FILE set — skipping"
fi
