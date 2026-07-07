# MCP conformance tests

Runs the official MCP conformance suites against Agents implementations inside workerd via `wrangler dev`.

## Lanes

| Command                                            | Protocol/lifecycle      | Endpoint              | Implementation                                        |
| -------------------------------------------------- | ----------------------- | --------------------- | ----------------------------------------------------- |
| `test:conformance:client`                          | Stable SDK v1 client    | n/a                   | `Agent` + `MCPClientManager`                          |
| `test:conformance:server:handler`                  | `2026-07-28`            | `/mcp-handler`        | SDK v2 stateless `createMcpHandler`                   |
| `test:conformance:server:handler:stateless-legacy` | 2025 stateless fallback | `/mcp-handler`        | Same SDK v2 handler, default `legacy: "stateless"`    |
| `test:conformance:server:handler:legacy`           | Stable SDK v1           | `/mcp-handler-legacy` | Complete handler/`WorkerTransport` compatibility lane |
| `test:conformance:server:mcp-agent`                | Stable SDK v1           | `/mcp-agent`          | Retained stateful `McpAgent`                          |

The stable `@modelcontextprotocol/conformance@0.1.16` dependency remains authoritative for the v1 client and server lanes. The independently exact-pinned `conformance-v2` npm alias exercises both generations served by the SDK v2 handler.

The v2 modern fixture is separate from the frozen SDK v1 fixture. It is adapted from the TypeScript SDK's current conformance server and includes modern envelopes, subscriptions, caching, request-header validation, and multi-round-trip input-required tools.

## Baselines

Each lifecycle has its own baseline:

- `baseline-server-handler-v2.yml` — modern SDK v2;
- `baseline-server-handler-stateless-legacy-v2.yml` — SDK v2's stateless 2025 fallback;
- `baseline-server-handler.yml` — complete SDK v1 handler compatibility;
- `baseline-server-mcp-agent.yml` — retained stateful Agent;
- `baseline-client.yml` — stable Agents MCP client.

Expected failures are scenario names. A stale entry fails the run, so fixing a gap requires removing its baseline entry.

## Running locally

```sh
cd packages/agents
pnpm run test:conformance

# Individual lanes
pnpm run test:conformance:server:handler
pnpm run test:conformance:server:handler:stateless-legacy
pnpm run test:conformance:server:handler:legacy
pnpm run test:conformance:server:mcp-agent
pnpm run test:conformance:client

# One scenario (extra CLI arguments pass through)
bash conformance/run.sh server-handler --scenario server-stateless
bash conformance/run.sh server-handler-stateless-legacy --scenario tools-list
```

The runner refuses to start when its port is occupied, preventing an accidental run against a stale Worker, and tears down the complete Wrangler/workerd process tree on exit.
