# MCP conformance tests

Runs the newest published MCP referee,
`@modelcontextprotocol/conformance@0.2.0-alpha.9`, against Agents inside
workerd via `wrangler dev`.

The harness is exact-pinned. All client and server lanes use this same version;
we do not mix counts from the older stable referee with modern results.

## Truthful result model

`conformance/run-suite.mjs` invokes the official referee once per official
scenario, but owns selection and reporting because alpha.9 has two aggregation
gaps:

1. its suite baseline ignores entries for scenarios that were not selected;
2. its client suite can report a scenario as passing even when the client
   process exits non-zero after the observed wire assertions.

Each lane reports four disjoint states:

- `✓ clean` — no failed/warning assertions and the client process exited
  successfully; any non-applicable `SKIPPED` assertions remain counted in the
  check totals;
- `~ expected failure` — the scenario ran and failed exactly as documented in
  that lane's baseline;
- `✗ unexpected failure` — a regression not present in the baseline;
- `- not exercised` — the upstream referee selected the scenario but emitted
  only `SKIPPED` assertions.

A baseline entry not selected by its full lane is an error. New upstream
scenarios missing from the driver manifest are also an error. Expected failures
are therefore neither ghost entries nor hidden passes.

## Client lanes

Every lane tests the same Agents `MCPClientManager` backed by the SDK v2 client.
The dated lanes prove that the modern client still interoperates with older
servers; compatibility is not inferred from the modern lane.

| Command                              | Server protocol/referee selection | Scenarios | Current result                 |
| ------------------------------------ | --------------------------------- | --------- | ------------------------------ |
| `test:conformance:client:modern`     | `2026-07-28`                      | 32        | 27 clean / 5 expected failures |
| `test:conformance:client:2025-11-25` | `2025-11-25`                      | 18        | 16 clean / 2 expected failures |
| `test:conformance:client:2025-06-18` | `2025-06-18`                      | 5         | 5 clean                        |
| `test:conformance:client:2025-03-26` | `2025-03-26` OAuth/backcompat     | 2         | 2 clean                        |
| `test:conformance:client:extensions` | off-timeline optional extensions  | 3         | 3 expected failures            |

The driver has an explicit upstream-scenario manifest and performs the same
scenario operations as the referee's reference client while routing MCP calls
through the real Agents manager. Scenario-specific behavior is driver behavior,
not a production-code branch.

## Server lanes

| Command                                            | Protocol/lifecycle      | Endpoint              | Current result                        |
| -------------------------------------------------- | ----------------------- | --------------------- | ------------------------------------- |
| `test:conformance:server:handler`                  | `2026-07-28` stateless  | `/mcp-handler`        | 40 clean                              |
| `test:conformance:server:handler:stateless-legacy` | `2025-11-25` stateless  | `/mcp-handler`        | 26 clean / 6 expected failures        |
| `test:conformance:server:handler:legacy`           | `2025-11-25` sessionful | `/mcp-handler-legacy` | 29 clean / 3 expected failures        |
| `test:conformance:server:mcp-agent`                | `2025-11-25` sessionful | `/mcp-agent`          | 29 clean / 3 expected failures        |
| `test:conformance:server:handler:extensions`       | modern optional tasks   | `/mcp-handler`        | 9 expected failures / 1 not exercised |

The stateless legacy lane runs all 32 applicable scenarios, not alpha.9's
smaller `active` subset. The two sessionful lanes remain because SDK v1 server
behavior is intentionally retained while consumers migrate.

## Baselines and impact

Each lane has its own baseline. Comments beside every entry state the practical
impact of leaving the behavior unchanged. A consolidated release-impact review
is in [`KNOWN_FAILURES.md`](./KNOWN_FAILURES.md).

Core protocol and optional extensions are separate. Unsupported optional tasks
never appear in the modern core baseline or reduce its stated clean count.

## Running locally

```sh
cd packages/agents

# Everything, serially
pnpm run test:conformance

# Client protocol matrix
pnpm run test:conformance:client:modern
pnpm run test:conformance:client:2025-11-25
pnpm run test:conformance:client:2025-06-18
pnpm run test:conformance:client:2025-03-26
pnpm run test:conformance:client:extensions

# Server lifecycle matrix
pnpm run test:conformance:server:handler
pnpm run test:conformance:server:handler:stateless-legacy
pnpm run test:conformance:server:handler:legacy
pnpm run test:conformance:server:mcp-agent
pnpm run test:conformance:server:handler:extensions

# Focus one scenario (uses the lane baseline but relaxes full-lane coverage)
bash conformance/run.sh client-modern --scenario sep-2322-client-request-state
bash conformance/run.sh server-handler --scenario server-stateless
```

The runner refuses to use an occupied Worker or inspector port and tears down
the complete Wrangler/workerd process tree on exit.

## Vendored modern server fixture

The modern fixture is separate from the frozen SDK v1 fixture. Its exact source
commit, source hash, local workerd adaptation, and update checker are documented
in [`vendor/README.md`](./vendor/README.md).
