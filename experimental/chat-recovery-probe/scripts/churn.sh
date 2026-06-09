#!/usr/bin/env bash
# Drive real deploy churn for the A1 invariant test.
# Deploys the worker every INTERVAL seconds, COUNT times. Each deploy replaces
# the isolate ("script has been upgraded") — the exact production interruption
# #1672 is about. A no-op content bump in an env var forces a fresh version.
#
# Usage: COUNT=5 INTERVAL=210 ./scripts/churn.sh
set -euo pipefail

COUNT="${COUNT:-5}"
INTERVAL="${INTERVAL:-210}"

cd "$(dirname "$0")/.."

for i in $(seq 1 "$COUNT"); do
  echo "=== deploy $i/$COUNT at $(date -u +%H:%M:%S) ==="
  CF_CHURN_MARKER="$(date +%s)" npx wrangler deploy --var "CHURN_MARKER:$(date +%s)" >/dev/null 2>&1 \
    && echo "deployed" || echo "deploy failed (continuing)"
  if [ "$i" -lt "$COUNT" ]; then
    echo "sleeping ${INTERVAL}s..."
    sleep "$INTERVAL"
  fi
done
echo "churn complete"
