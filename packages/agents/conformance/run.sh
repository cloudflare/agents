#!/usr/bin/env bash
# Runs the MCP conformance suite against the implementations in this package.
#
# 1. Starts the conformance worker (workerd via wrangler dev) hosting:
#      - the MCP client under test (Agent + MCPClientManager)
#      - two MCP servers under test (McpAgent at /mcp-agent,
#        createMcpHandler + WorkerTransport at /mcp-handler)
# 2. Runs the @modelcontextprotocol/conformance CLI in the requested mode.
#
# Usage:
#   conformance/run.sh client          [extra conformance CLI args]
#   conformance/run.sh server-mcp-agent [extra conformance CLI args]
#   conformance/run.sh server-handler   [extra conformance CLI args]
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:?Usage: run.sh <client|server-mcp-agent|server-handler> [conformance CLI args]}"
shift

PORT="${CONFORMANCE_WORKER_PORT:-8788}"

pnpm exec wrangler dev --config conformance/wrangler.jsonc --port "$PORT" --ip 127.0.0.1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true' EXIT

echo "Waiting for conformance worker on port $PORT..."
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    break
  fi
  sleep 1
done

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "Conformance worker failed to start" >&2
  exit 1
fi

# Run every server scenario as its own conformance invocation. `--suite`
# runs scenarios in parallel against the worker, which makes the timing-
# sensitive SSE scenarios (server-sse-polling) record different results on
# fast vs slow machines; sequential single-scenario runs are deterministic.
run_server_scenarios() {
  local url="$1" baseline="$2"
  shift 2

  if [ "$#" -gt 0 ]; then
    pnpm exec conformance server --url "$url" --expected-failures "$baseline" "$@"
    return
  fi

  local scenarios failed=0
  scenarios=$(pnpm exec conformance list 2>/dev/null |
    awk '/^Server scenarios/{f=1;next} /^Client scenarios/{f=0} f && /^  - /{print $2}')
  if [ -z "$scenarios" ]; then
    echo "Failed to list server scenarios" >&2
    return 1
  fi

  local out
  out=$(mktemp)
  for scenario in $scenarios; do
    if pnpm exec conformance server --url "$url" --scenario "$scenario" \
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
    # --timeout: scenarios that exercise SSE reconnection legitimately take
    # >30s (default) on slow CI runners once the SDK's retry interval and
    # connection backoff stack up.
    CONFORMANCE_WORKER_ORIGIN="http://127.0.0.1:$PORT" pnpm exec conformance client \
      --command "node conformance/driver.mjs" \
      --expected-failures conformance/baseline-client.yml \
      --timeout 90000 \
      "$@"
    ;;
  server-mcp-agent)
    run_server_scenarios "http://127.0.0.1:$PORT/mcp-agent" \
      conformance/baseline-server-mcp-agent.yml "$@"
    ;;
  server-handler)
    run_server_scenarios "http://127.0.0.1:$PORT/mcp-handler" \
      conformance/baseline-server-handler.yml "$@"
    ;;
  *)
    echo "Unknown mode: $MODE (expected client, server-mcp-agent, or server-handler)" >&2
    exit 1
    ;;
esac
