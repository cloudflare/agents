# MCP conformance tests

Runs the exact-pinned MCP referee,
`@modelcontextprotocol/conformance@0.2.0-alpha.10`, against Agents inside
workerd via `wrangler dev`.

`conformance/run-suite.mjs` delegates each scenario to the official CLI. It
adds only the behavior the alpha referee does not provide reliably in suite
mode:

- bounded client concurrency;
- process-group cleanup for spawned drivers and mock servers;
- non-zero client exits count as failures even when wire assertions pass;
- server warnings count as failures unless the scenario is baselined;
- every expected-failure entry must belong to the selected dated lane.

The runner classifies each scenario as clean, expected failure, unexpected
failure, or stale baseline. An unexpected failure or stale baseline fails CI.

## Client lanes

Every lane tests the same Agents `MCPClientManager` backed by the SDK v2 client.
The older lanes prove fallback interoperability rather than inferring it from
the current protocol lane.

| Command                              | Server protocol/referee selection | Scenarios | Current result                 |
| ------------------------------------ | --------------------------------- | --------- | ------------------------------ |
| `test:conformance:client:stateless`  | `2026-07-28`                      | 32        | 28 clean / 4 expected failures |
| `test:conformance:client:2025-11-25` | `2025-11-25`                      | 18        | 16 clean / 2 expected failures |
| `test:conformance:client:2025-06-18` | `2025-06-18`                      | 5         | 5 clean                        |
| `test:conformance:client:2025-03-26` | `2025-03-26` OAuth/backcompat     | 2         | 2 clean                        |

The driver keeps an explicit manifest of the upstream scenarios it implements.
A new selected scenario missing from that manifest fails before the lane runs.

## Server lanes

| Command                                         | Protocol/lifecycle              | Endpoint              | Current result                 |
| ----------------------------------------------- | ------------------------------- | --------------------- | ------------------------------ |
| `test:conformance:server:handler`               | stateless (`2026-07-28`)        | `/mcp-handler`        | 40 clean                       |
| `test:conformance:server:handler:legacy-compat` | legacy compatibility, stateless | `/mcp-handler`        | 26 clean / 6 expected failures |
| `test:conformance:server:handler:legacy`        | legacy, sessionful              | `/mcp-handler-legacy` | 29 clean / 3 expected failures |
| `test:conformance:server:mcp-agent`             | legacy, sessionful              | `/mcp-agent`          | 29 clean / 3 expected failures |

The compatibility lanes have dedicated, non-empty baselines. Comments beside
every expected failure explain its practical impact and whether the behavior
belongs to Agents, SDK v1, or the alpha referee fixture. The stateless handler
has no expected failures.

Optional extensions are not release gates for this SDK migration. Unsupported
Tasks and client-credentials scenarios remain outside this core/compatibility
matrix rather than appearing as permanently failing CI lanes.

## Running locally

```sh
cd packages/agents

# Everything, serially
pnpm run test:conformance

# Client protocol matrix
pnpm run test:conformance:client:stateless
pnpm run test:conformance:client:2025-11-25
pnpm run test:conformance:client:2025-06-18
pnpm run test:conformance:client:2025-03-26

# Server lifecycle matrix
pnpm run test:conformance:server:handler
pnpm run test:conformance:server:handler:legacy-compat
pnpm run test:conformance:server:handler:legacy
pnpm run test:conformance:server:mcp-agent

# Focus one scenario
bash conformance/run.sh client-stateless --scenario sep-2322-client-request-state
bash conformance/run.sh server-handler --scenario server-stateless
```

The runner refuses occupied Worker and inspector ports and tears down the
complete Wrangler/workerd process tree on exit.

## Vendored server fixture

The stateless server fixture is a workerd adaptation of the exact upstream SDK
v2 conformance fixture. Its source commit and adaptation boundary are recorded
in [`vendor/README.md`](./vendor/README.md). The SDK does not publish the fixture
as an importable module, and its upstream entrypoint depends on Node and
Express, so the local adaptation is required to exercise the server inside
workerd.
