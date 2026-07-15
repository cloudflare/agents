#!/usr/bin/env bash
# Runs the newest published MCP conformance referee (alpha.9) against Agents
# implementations inside workerd. Protocol revisions and optional extensions
# are separate lanes; run-suite.mjs makes baseline coverage fail-closed and
# reports clean, expected-failure, unexpected-failure, and not-exercised states.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:?Usage: run.sh <client-*|server-*> [--scenario name]}"
shift

PORT="${CONFORMANCE_WORKER_PORT:-8788}"
INSPECTOR_PORT="${CONFORMANCE_INSPECTOR_PORT:-$((PORT + 10000))}"
WORKER_ORIGIN="http://127.0.0.1:$PORT"
CONFORMANCE="node_modules/@modelcontextprotocol/conformance-v2/dist/index.js"
DRIVER="conformance/driver.mjs"

if (: > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "Conformance port $PORT is already in use; refusing to test against a stale worker" >&2
  exit 1
fi
if (: > "/dev/tcp/127.0.0.1/$INSPECTOR_PORT") 2>/dev/null; then
  echo "Conformance inspector port $INSPECTOR_PORT is already in use" >&2
  exit 1
fi

PERSIST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agents-mcp-conformance.XXXXXX")"

pnpm exec wrangler dev \
  --config conformance/wrangler.jsonc \
  --port "$PORT" \
  --inspector-port "$INSPECTOR_PORT" \
  --persist-to "$PERSIST_DIR" \
  --ip 127.0.0.1 &
WRANGLER_PID=$!

kill_process_tree() {
  local parent="$1" child
  while read -r child; do
    [ -n "$child" ] && kill_process_tree "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
  kill "$parent" 2>/dev/null || true
}

cleanup() {
  kill_process_tree "$WRANGLER_PID"
  wait "$WRANGLER_PID" 2>/dev/null || true
  rm -rf "$PERSIST_DIR"
}
trap cleanup EXIT

echo "Waiting for conformance worker on port $PORT..."
ready=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$WORKER_ORIGIN/"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Conformance worker failed to start" >&2
  exit 1
fi

run_client() {
  local version="$1" baseline="$2"
  shift 2
  CONFORMANCE_WORKER_ORIGIN="$WORKER_ORIGIN" node conformance/run-suite.mjs client \
    --conformance "$CONFORMANCE" \
    --baseline "$baseline" \
    --spec-version "$version" \
    --driver "$DRIVER" \
    --concurrency 6 \
    --client-timeout 90000 \
    --scenario-timeout 150000 \
    "$@"
}

run_server() {
  local url="$1" version="$2" baseline="$3"
  shift 3
  node conformance/run-suite.mjs server \
    --conformance "$CONFORMANCE" \
    --baseline "$baseline" \
    --url "$url" \
    --spec-version "$version" \
    --concurrency 1 \
    --scenario-timeout 150000 \
    "$@"
}

case "$MODE" in
  client-modern)
    run_client 2026-07-28 conformance/baseline-client-2026-07-28.yml "$@"
    ;;
  client-2025-11-25)
    run_client 2025-11-25 conformance/baseline-client-2025-11-25.yml "$@"
    ;;
  client-2025-06-18)
    run_client 2025-06-18 conformance/baseline-client-2025-06-18.yml "$@"
    ;;
  client-2025-03-26)
    run_client 2025-03-26 conformance/baseline-client-2025-03-26.yml "$@"
    ;;
  client-extensions)
    CONFORMANCE_WORKER_ORIGIN="$WORKER_ORIGIN" node conformance/run-suite.mjs client \
      --conformance "$CONFORMANCE" \
      --baseline conformance/baseline-client-extensions.yml \
      --suite extensions \
      --driver "$DRIVER" \
      --concurrency 3 \
      --client-timeout 90000 \
      --scenario-timeout 150000 \
      "$@"
    ;;
  server-handler)
    run_server "$WORKER_ORIGIN/mcp-handler" 2026-07-28 \
      conformance/baseline-server-handler-v2.yml "$@"
    ;;
  server-handler-stateless-legacy)
    run_server "$WORKER_ORIGIN/mcp-handler" 2025-11-25 \
      conformance/baseline-server-handler-stateless-legacy-v2.yml "$@"
    ;;
  server-handler-legacy)
    run_server "$WORKER_ORIGIN/mcp-handler-legacy" 2025-11-25 \
      conformance/baseline-server-handler.yml "$@"
    ;;
  server-mcp-agent)
    run_server "$WORKER_ORIGIN/mcp-agent" 2025-11-25 \
      conformance/baseline-server-mcp-agent.yml "$@"
    ;;
  server-handler-extensions)
    node conformance/run-suite.mjs server \
      --conformance "$CONFORMANCE" \
      --baseline conformance/baseline-server-handler-extensions-v2.yml \
      --url "$WORKER_ORIGIN/mcp-handler" \
      --suite extensions \
      --concurrency 1 \
      --scenario-timeout 150000 \
      "$@"
    ;;
  *)
    echo "Unknown conformance mode: $MODE" >&2
    exit 1
    ;;
esac
