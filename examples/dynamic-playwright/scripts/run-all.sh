#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

for case_file in scripts/cases/*; do
  printf '\n== %s ==\n' "$case_file"
  ./scripts/run.sh "$case_file"
done
