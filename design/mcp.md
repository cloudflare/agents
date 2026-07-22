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

1. applications declare and can audit the exact SDK beta they use;
2. upstream SDK documentation and types map directly to the import;
3. multiple installed SDK copies are less likely to be hidden behind an Agents alias.

The tradeoff is one additional import and direct peer installation. That is preferable to coupling Agents releases to ownership of the upstream constructor API.

## Source boundaries

### Stateless

- `server.ts` — public, tree-shakeable entry.
- `handler-stateless.ts` — Worker route, CORS, Host/Origin policy, auth context, and dispatch between Stateless and Legacy compatibility requests.
- `handler-legacy-compat.ts` — per-request SDK v2 transport for Legacy compatibility, including fail-fast reverse requests, close tracking, and Cloudflare SSE keepalives.

### Legacy

- `legacy-agent.ts` — deprecated, feature-frozen `McpAgent` implementation.
- `handler-legacy.ts` — explicit SDK v1 handler.
- `worker-transport.ts` — SDK v1 Worker transport with session persistence and SSE keepalives.
- `transport.ts` and `event-store.ts` — sessionful McpAgent transport and replay support.

### Compatibility

- `handler-compat.ts` — historical overloaded `createMcpHandler`; functions remain available from `agents/mcp` without making the Stateless entry retain Legacy modules.
- `index.ts` — compatibility barrel. It contains no implementation.

## Lifecycles

### Stateless server

1. The client sends `server/discover`.
2. Each catalog or operation request constructs a fresh `McpServer`/`Server` from the factory.
3. The handler connects it to a single-exchange transport and returns JSON or SSE.
4. The server and transport close when the response completes, is cancelled, aborts, or the handler closes.
5. Stateless Elicitation returns `input_required`; the SDK carries `requestState` and `inputResponses` between requests.

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
