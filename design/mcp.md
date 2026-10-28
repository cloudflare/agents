# MCP architecture

## Terminology

The codebase uses three deliberately distinct terms:

- **Stateless** — the SDK v2 server and client path. A fresh server instance serves each HTTP request. Stateless Elicitation works through multi-round-trip requests (MRTR).
- **Legacy** — retained SDK v1, sessionful server behavior. `McpAgent`, `createLegacyMcpHandler`, and `WorkerTransport` belong here. Legacy Elicitation uses pushed server-to-client requests.
- **Legacy compatibility** — Legacy protocol requests accepted by the Stateless handler without a session. It uses the SDK v2 web-standard transport, not `WorkerTransport`. Catalog and ordinary operation requests work; session operations, pushed server-to-client requests, and SSE recovery do not.

Exact protocol-version strings remain at wire and conformance boundaries, but are not architecture names.

## Public package boundaries

| Import              | Responsibility                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `agents/mcp/server` | Isolated Stateless Worker handler and Agents auth-context helper      |
| `agents/mcp/client` | Agent-side MCP client manager and connection APIs                     |
| `agents/mcp`        | Compatibility barrel retaining existing Legacy and historical imports |

Stateless server constructors and protocol helpers remain owned by `@modelcontextprotocol/server`:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
```

Agents does not re-export `McpServer`. Keeping the ownership boundary explicit has three benefits:

1. applications declare and can audit the exact SDK release they use;
2. upstream SDK documentation and types map directly to the import;
3. multiple installed SDK copies are less likely to be hidden behind an Agents alias.

The tradeoff is one additional import and direct peer installation. That is preferable to coupling Agents releases to ownership of the upstream constructor API.

## Source boundaries

All server-side modules live in `src/mcp/server/`; the client manager and its
supporting modules live in `src/mcp/client/`; `types.ts`, `rpc.ts`, and
`abort.ts` are shared at the module root.

### Stateless

- `server/index.ts` — public, tree-shakeable entry (`agents/mcp/server`).
- `server/handler-stateless.ts` — Worker route, CORS, Host/Origin policy, auth context, and dispatch between Stateless and Legacy compatibility requests.
- `server/handler-legacy-compat.ts` — per-request SDK v2 transport for Legacy compatibility, including fail-fast reverse requests and close tracking. SSE keepalives are owned by the SDK transport.

### Legacy

- `server/legacy-agent.ts` — deprecated, feature-frozen `McpAgent` implementation.
- `server/handler-legacy.ts` — explicit SDK v1 handler.
- `server/worker-transport.ts` — SDK v1 Worker transport with session persistence; SDK v1 owns its SSE keepalives.
- `server/transport.ts` and `server/event-store.ts` — sessionful McpAgent transport and replay support. The WebSocket-to-SSE bridge retains the only Agents-owned MCP keepalive timer.

### Compatibility

- `server/handler-compat.ts` — historical overloaded `createMcpHandler`; functions remain available from `agents/mcp` without making the Stateless entry retain Legacy modules.
- `index.ts` — compatibility barrel. It contains no implementation.

## Lifecycles

### Stateless server

1. The client sends `server/discover`.
2. Each catalog or operation request constructs a fresh `McpServer`/`Server` from the factory.
3. The handler connects it to a single-exchange transport and returns JSON or SSE.
4. The server and transport close when the response completes, is cancelled, or aborts.
5. Stateless Elicitation returns `input_required`; each retry carries the latest `requestState` and that round's `inputResponses`.

### Legacy compatibility

1. The client initializes through the Stateless endpoint's compatibility lane.
2. Each POST receives a fresh SDK v2 server/transport pair.
3. Catalogs and ordinary tools, prompts, resources, completion, logging, and progress work.
4. GET/DELETE session operations return `405`; pushed sampling/elicitation/list-roots fail immediately; disconnected response streams cannot resume.

### Legacy sessionful server

1. A session ID addresses an `McpAgent` or Agent-backed `createLegacyMcpHandler` instance.
2. `WorkerTransport` persists initialization state through Durable Object hibernation.
3. The response or standalone SSE stream carries pushed requests and notifications.
4. `DurableObjectEventStore` can replay stored SSE events after reconnect.

### Client

The SDK v2 client negotiates Stateless first and falls back to Legacy on the same connection. Agents persists the selected protocol and discovery result alongside resumable HTTP state. An in-flight elicitation handler and continuation remain memory-only; isolate restart rejects the operation and the caller retries it.

`MCPClientManager` (`src/mcp/client/manager.ts`) is the public API and the Lifecycle hooks; it decides nothing itself. It keeps one `MCPClientConnection` per server and hands every controller one `McpClientContext` (`context.ts`): the connections, the store, the lanes, storage, and the manager's events. Dependencies point one way, top to bottom:

| Module                      | Owns                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers.ts`                | Each server's life: register, connect, discover, restore, settle, reconnect, close, remove, migrate. `afterFailure` is the one place that decides retry or stop. |
| `authorization.ts`          | Links and OAuth: entering `authenticating` (round limit, spent links), callbacks, request recovery, link expiry, provider creation and storage                   |
| `status.ts`                 | The transitions both share: stop with a recorded failure, ready, save the session                                                                                |
| `jobs.ts`                   | The durable `connect` and `auth-expiry` jobs and the reconnect policy; schedules, moves and cancels, decides nothing                                             |
| `elicitation.ts`            | Elicitation handlers and the capabilities they advertise                                                                                                         |
| `legacy-connect.ts`         | The deprecated `connect()`                                                                                                                                       |
| `server-store.ts`           | Every SQL statement over `cf_agents_mcp_servers`                                                                                                                 |
| `server-lanes.ts`           | One queue of connection work per server; re-entrant for nested calls                                                                                             |
| `authorization-turns.ts`    | One OAuth flow at a time per connection, so concurrent 401s share one client and one link                                                                        |
| `authorization-rounds.ts`   | The step-up round count, as pure functions                                                                                                                       |
| `oauth-callback.ts`         | Callback recognition and parsing, state checks, code exchange, response rendering                                                                                |
| `catalog.ts`, `ai-tools.ts` | Paginated catalogs, namespaced listings and filters; AI SDK tool conversion                                                                                      |
| `url-policy.ts`             | Stable server ids and the SSRF policy                                                                                                                            |
| `connection.ts`             | Transport selection, the SDK client, catalogs and the connection-level state machine                                                                             |

`servers.ts` reaches `connectToServer` and `discoverIfConnected` through the manager, so a subclass override (or a test spy) sees internal calls too.

Connect, discovery, establish, OAuth callback completion and restore for one server run through its lane, so they never interleave on one connection.

Background work that must happen even if the isolate dies lives in the Lifecycle job queue (`jobs.ts`), not in memory:

- `connect:<serverId>`: after a failed connect or discovery, the next attempt on a 30s → 30m backoff. Each run is one bounded attempt. Restore leaves a server with a pending job `failed` (showing the job's last error) instead of connecting early. Ready or `authenticating` cancels it; 24h without success records a `reconnect-exhausted` failure. A refused authorization is never retried: a 401 no link can answer, a 403 left after any step-up, or an OAuth error other than `server_error` / `temporarily_unavailable` records an `authorization-failed` failure instead of scheduling the job. `migrateServerId` moves both jobs to the new id.
- `auth-expiry:<serverId>`: armed with every persisted `auth_url`. If the link's `state` can no longer be redeemed when it fires, the server records an `authorization-expired` failure instead of minting a new link. The OAuth callback clears `auth_url` before it redeems the state, so a dead link found on wake was never completed and is recorded the same way.

Re-authorization follows the spec's step-up retry limit (`authorization-rounds.ts`): rounds are counted per requested scope set, a round counts once its callback completed and the server asked for the same scopes again, and a fourth round within an hour records an `authorization-exhausted` failure instead of showing a link. Several links for one pending ask count as one round.

A recorded failure (`failure` column, added on first use) is terminal: restore shows it without connecting, and only an explicit reconnect (`reconnectMcpServer` / `reconnectServer`, or the manager's `connectToServer` and `establishConnection`) clears it. `addMcpServer` for a registered server reconnects it when it isn't connected, at most once per first backoff step (apps call it from `onStart` and `onConnect`), and only an `authorization-expired` failure is cleared that way; refused, denied, step-up-exhausted and given-up servers wait for `reconnectMcpServer`. A denied or failed callback, a link older than 24h, and a 401 right after a completed authorization are recorded the same way; the manager remembers the state each callback redeemed so that link is never shown again. A server is `authenticating` exactly when the manager has persisted the `auth_url` its provider produced; connect, discovery and request-time re-authorization (scope step-up, failed refresh) all enter that state through one transition. Restore trusts a persisted `auth_url` only while its OAuth `state` can still be redeemed, and otherwise reconnects. Work that outlives `removeServer` (a connect, discovery or code exchange) checks it still owns the connection before writing anything back.

## Verification matrix

| Surface                    | Evidence                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateless server lifecycle | Official server referee: discovery, catalogs, tool result shapes, errors, progress, prompts, resources, completion, headers, caching, and input-required cases |
| Legacy compatibility       | Official Legacy server scenarios against the Stateless endpoint; expected failures are limited to session/reverse-request behavior                             |
| Legacy sessionful handler  | Official Legacy server scenarios against `createLegacyMcpHandler`                                                                                              |
| McpAgent                   | Separate official Legacy server lane                                                                                                                           |
| Stateless client           | Official client referee plus `v2-lifecycle.test.ts` and `client-v2-mrtr.test.ts`                                                                               |
| Legacy client fallback     | Dated official client lanes plus the Legacy arm of `v2-lifecycle.test.ts`                                                                                      |
| Bundle isolation           | `mcp-server-bundle.test.ts` rejects SDK v1, MCP client, PartyServer, `McpAgent`, and `WorkerTransport` modules                                                 |

`packages/agents/conformance/README.md` owns exact scenario counts and expected-failure rationale.

## Tradeoffs

- `agents/mcp` remains broad for backward compatibility; new servers must opt into `agents/mcp/server` to get the isolated graph.
- Legacy compatibility maximizes client reach but cannot emulate a session. Applications requiring Legacy Elicitation or replay must mount a Legacy server.
- Origin validation is enabled by default. `allowedOriginHostnames: "*"` is only appropriate when trusted upstream middleware enforces the required policy.
- Handler-produced protocol errors remain in-band according to MCP transport semantics. Mapping a downstream tool's authentication failure to the endpoint's HTTP authentication status is a separate API/protocol decision, not part of server entry isolation.
