# MCP conformance tests

Runs the official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
(`@modelcontextprotocol/conformance`) against the MCP implementations in this
package, the same way the
[MCP TypeScript SDK does](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/test/conformance).

Everything under test runs inside workerd (via `wrangler dev`), so the
implementations are exercised as they actually run in production — Durable
Object storage, real routes, real transports — not a Node approximation.

## What is tested

| Suite    | Implementation under test                                                               | Entry point                      |
| -------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| `client` | `Agent` + `MCPClientManager` (+ `DurableObjectOAuthClientProvider` for OAuth scenarios) | `ConformanceHost` in `worker.ts` |
| `server` | `McpAgent`                                                                              | `/mcp-agent` in `worker.ts`      |
| `server` | `createMcpHandler` + `WorkerTransport` inside an `Agent`                                | `/mcp-handler` in `worker.ts`    |

Both server variants register the same feature set (`everything-server.ts`,
ported from the TypeScript SDK's conformance "everything server").

## How it works

```
conformance CLI ──spawns per scenario──▶ driver.mjs (Node, plays "browser")
                                            │ POST /agents/conformance-host/<uuid>/run
                                            ▼
wrangler dev ──▶ ConformanceHost (Agent DO) ──addMcpServer()──▶ conformance test server
                       ▲ real OAuth callback route ◀── driver follows authUrl redirect
```

- **Client suite**: the conformance CLI starts a reference MCP server per
  scenario and spawns `driver.mjs` to connect to it. The driver forwards the
  scenario to a fresh `ConformanceHost` agent instance, which connects out via
  `addMcpServer()`. For OAuth scenarios the worker returns the authorization
  URL and the driver simulates the user's browser: it follows the redirect
  chain into the worker's real `/callback` route, then resumes the scenario.
- **Server suites**: the conformance CLI acts as a reference MCP client and
  talks directly to the two server endpoints on the worker.

## Running locally

```sh
cd packages/agents
pnpm run test:conformance                    # all three suites
pnpm run test:conformance:client             # client only
pnpm run test:conformance:server:mcp-agent   # McpAgent server only
pnpm run test:conformance:server:handler     # createMcpHandler server only

# Single scenario:
bash conformance/run.sh client --scenario initialize
bash conformance/run.sh server-mcp-agent --scenario tools-call-simple-text
```

## Baselines (expected failures)

Known gaps are recorded in `baseline-*.yml` so CI stays green while still
catching regressions and new failures. Each entry documents why the scenario
fails — remove entries as the gaps get fixed.
