#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
CASE_FILE="${1:-}"

if [[ -z "$CASE_FILE" ]]; then
  printf 'usage: ./scripts/run.sh scripts/cases/01-launch-and-title.js\n' >&2
  exit 2
fi

if [[ ! -f "$CASE_FILE" ]]; then
  printf 'case file not found: %s\n' "$CASE_FILE" >&2
  exit 2
fi

npx tsx ./scripts/run.ts "$CASE_FILE" "http://localhost:${PORT}/"
