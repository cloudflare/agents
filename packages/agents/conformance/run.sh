#!/usr/bin/env bash
# Runs MCP conformance against the implementations hosted by worker.ts.
#
# Stable @modelcontextprotocol/conformance@0.1.16 remains authoritative for
# the SDK v1 client, McpAgent, and complete handler compatibility lanes.
# The independently pinned conformance-v2 alias exercises the SDK v2 handler
# at both 2026-07-28 and its default stateless 2025 fallback.
#
# Usage:
#   conformance/run.sh client [extra stable CLI args]
#   conformance/run.sh server-mcp-agent [extra stable CLI args]
#   conformance/run.sh server-handler [extra v2 CLI args]
#   conformance/run.sh server-handler-stateless-legacy [extra v2 CLI args]
#   conformance/run.sh server-handler-legacy [extra stable CLI args]
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:?Usage: run.sh <client|server-mcp-agent|server-handler|server-handler-stateless-legacy|server-handler-legacy> [conformance CLI args]}"
shift

PORT="${CONFORMANCE_WORKER_PORT:-8788}"
WORKER_ORIGIN="http://127.0.0.1:$PORT"
CONFORMANCE_V1=(node node_modules/@modelcontextprotocol/conformance/dist/index.js)
CONFORMANCE_V2=(node node_modules/@modelcontextprotocol/conformance-v2/dist/index.js)

if (: > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "Conformance port $PORT is already in use; refusing to test against a stale worker" >&2
  exit 1
fi

pnpm exec wrangler dev --config conformance/wrangler.jsonc --port "$PORT" --ip 127.0.0.1 &
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
}
trap cleanup EXIT

echo "Waiting for conformance worker on port $PORT..."
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$WORKER_ORIGIN/"; then
    break
  fi
  sleep 1
done

if ! curl -s -o /dev/null "$WORKER_ORIGIN/"; then
  echo "Conformance worker failed to start" >&2
  exit 1
fi

# The stable 0.1 CLI's suite mode runs scenarios in parallel, which makes its
# timing-sensitive SSE checks nondeterministic. Run those legacy scenarios one
# at a time. The v2 CLI's server suite is already sequential.
run_stable_server_scenarios() {
  local url="$1" baseline="$2"
  shift 2

  if [ "$#" -gt 0 ]; then
    "${CONFORMANCE_V1[@]}" server --url "$url" --expected-failures "$baseline" "$@"
    return
  fi

  local scenarios failed=0
  scenarios=$("${CONFORMANCE_V1[@]}" list 2>/dev/null |
    awk '/^Server scenarios/{f=1;next} /^Client scenarios/{f=0} f && /^  - /{print $2}')
  if [ -z "$scenarios" ]; then
    echo "Failed to list stable server scenarios" >&2
    return 1
  fi

  local out
  out=$(mktemp)
  for scenario in $scenarios; do
    if "${CONFORMANCE_V1[@]}" server --url "$url" --scenario "$scenario" \
      --expected-failures "$baseline" > "$out" 2>&1; then
      echo "✓ $scenario"
    else
      echo "✗ $scenario"
      tail -30 "$out"
      failed=1
    fi
  done
  rm -f "$out"
  return "$failed"
}

case "$MODE" in
  client)
    CONFORMANCE_WORKER_ORIGIN="$WORKER_ORIGIN" "${CONFORMANCE_V1[@]}" client \
      --command "node conformance/driver.mjs" \
      --expected-failures conformance/baseline-client.yml \
      --timeout 90000 \
      "$@"
    ;;
  server-mcp-agent)
    run_stable_server_scenarios "$WORKER_ORIGIN/mcp-agent" \
      conformance/baseline-server-mcp-agent.yml "$@"
    ;;
  server-handler)
    "${CONFORMANCE_V2[@]}" server \
      --url "$WORKER_ORIGIN/mcp-handler" \
      --suite all \
      --spec-version 2026-07-28 \
      --expected-failures conformance/baseline-server-handler-v2.yml \
      "$@"
    ;;
  server-handler-stateless-legacy)
    "${CONFORMANCE_V2[@]}" server \
      --url "$WORKER_ORIGIN/mcp-handler" \
      --suite active \
      --spec-version 2025-11-25 \
      --expected-failures conformance/baseline-server-handler-stateless-legacy-v2.yml \
      "$@"
    ;;
  server-handler-legacy)
    run_stable_server_scenarios "$WORKER_ORIGIN/mcp-handler-legacy" \
      conformance/baseline-server-handler.yml "$@"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
