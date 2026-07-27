#!/usr/bin/env bash
# Runs the exact-pinned MCP conformance referee (alpha.10) against Agents
# implementations inside workerd. run-suite.mjs bounds client concurrency,
# makes baseline coverage fail-closed, and treats client process failures and
# server warning checks as failures even when the referee exits successfully.
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
  local version="$1" baseline="${2:-}"
  shift 2
  local args=(
    --conformance "$CONFORMANCE"
    --spec-version "$version"
    --driver "$DRIVER"
    --concurrency 6
    --client-timeout 90000
    --scenario-timeout 150000
  )
  [ -n "$baseline" ] && args+=(--baseline "$baseline")
  CONFORMANCE_WORKER_ORIGIN="$WORKER_ORIGIN" \
    node conformance/run-suite.mjs client "${args[@]}" "$@"
}

run_server() {
  local url="$1" version="$2" baseline="${3:-}"
  shift 3
  local args=(
    --conformance "$CONFORMANCE"
    --url "$url"
    --spec-version "$version"
    --concurrency 1
    --scenario-timeout 150000
  )
  [ -n "$baseline" ] && args+=(--baseline "$baseline")
  node conformance/run-suite.mjs server "${args[@]}" "$@"
}

case "$MODE" in
  client-stateless)
    run_client 2026-07-28 conformance/baseline-client-2026-07-28.yml "$@"
    ;;
  client-2025-11-25)
    run_client 2025-11-25 conformance/baseline-client-2025-11-25.yml "$@"
    ;;
  client-2025-06-18)
    run_client 2025-06-18 "" "$@"
    ;;
  client-2025-03-26)
    run_client 2025-03-26 "" "$@"
    ;;
  server-handler)
    run_server "$WORKER_ORIGIN/mcp-handler" 2026-07-28 "" "$@"
    ;;
  server-handler-legacy-compat)
    run_server "$WORKER_ORIGIN/mcp-handler" 2025-11-25 \
      conformance/baseline-server-handler-legacy-compat.yml "$@"
    ;;
  server-handler-legacy)
    run_server "$WORKER_ORIGIN/mcp-handler-legacy" 2025-11-25 \
      conformance/baseline-server-handler.yml "$@"
    ;;
  server-mcp-agent)
    run_server "$WORKER_ORIGIN/mcp-agent" 2025-11-25 \
      conformance/baseline-server-mcp-agent.yml "$@"
    ;;
  *)
    echo "Unknown conformance mode: $MODE" >&2
    exit 1
    ;;
esac
