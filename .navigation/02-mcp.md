# 02 — Model Context Protocol (MCP)

MCP is the standard wire protocol for exposing tools, resources, and prompts to LLMs. This codebase implements both sides: an MCP **server** (your agent hosts tools that an LLM can call) and an MCP **client** (your agent connects to external servers to use their tools).

All MCP code lives in `packages/agents/src/mcp/`.

---

## Types and shared constants

[`TransportType`, `ServeOptions`, `CORSOptions`](../packages/agents/src/mcp/types.ts#L1-L25) — the three transport types (`"sse"`, `"streamable-http"`, `"rpc"`) and the config for serving a handler over HTTP.

[`isUnauthorized()` and `isTransportNotImplemented()`](../packages/agents/src/mcp/errors.ts#L1-L39) — error classifiers used during transport negotiation. When a client tries streamable-HTTP and gets a 404/405, these tell the retry logic to fall back to SSE.

[`getMcpAuthContext()` and `runWithAuthContext()`](../packages/agents/src/mcp/auth-context.ts#L1-L15) — thin wrappers around `AsyncLocalStorage` that propagate OAuth credentials through the call stack without explicit parameter threading.

---

## Server side — McpAgent

`McpAgent` is the abstract base class for agents that *are* an MCP server. Extend it and implement `init()` to register your tools, resources, and prompts with an `McpServer` instance from the `@modelcontextprotocol/sdk` package.

[`McpAgent<Env, State, Props>` class](../packages/agents/src/mcp/index.ts#L30-L553) — the full class. Key things to note:

[`getTransportType()` and `getSessionId()`](../packages/agents/src/mcp/index.ts#L71-L99) — the agent's Durable Object name encodes the transport and session ID, e.g. `sse:abc123`. These helpers parse that name. The transport type determines which transport class is wired up in `onStart()`.

[`onStart()` — transport initialisation](../packages/agents/src/mcp/index.ts#L167-L187) — connects the MCP server to the appropriate transport. For SSE and streamable-HTTP the transport holds a WebSocket or HTTP response stream; for RPC it uses the Durable Object's message channel.

[`elicitInput(schema, options?)` method](../packages/agents/src/mcp/index.ts#L279-L305) — lets a tool handler pause and ask the connected *user* (not the LLM) for additional input with a validated schema. The underlying MCP elicitation protocol is handled here; your tool just `await`s this and gets back a typed response.

---

## Server side — transports

Four transport classes sit between the `McpServer` and the network. They share the same job: accept incoming JSON-RPC from a client and feed responses back.

**SSE transport** (used when the client opened an SSE stream first):

[`McpSSETransport`](../packages/agents/src/mcp/transport.ts#L25-L71) — a minimal wrapper around the agent's WebSocket connection. Each `send()` call writes one SSE event. Lifecycle mirrors the WebSocket's.

**Streamable-HTTP transport** (the modern approach, single endpoint):

[`StreamableHTTPServerTransport`](../packages/agents/src/mcp/transport.ts#L93-L385) — handles POST (JSON-RPC requests), GET (SSE stream for server-pushed notifications), and DELETE (session close). Tracks request→response pairing so batched requests route back to the right response.

[`handlePostRequest()` in StreamableHTTPServerTransport](../packages/agents/src/mcp/transport.ts#L218-L290) — the hot path: parse a JSON-RPC batch, call the server, stream results.

**Worker transport** (for serving MCP directly from a plain Worker, no Durable Object):

[`WorkerTransport`](../packages/agents/src/mcp/worker-transport.ts#L90-L941) — similar to `StreamableHTTPServerTransport` but designed for stateless Workers. Persists session state to Durable Object storage (via `restoreState()` / `saveState()`) to survive request boundaries.

[`handleGetRequest()` in WorkerTransport](../packages/agents/src/mcp/worker-transport.ts#L270-L402) — sets up the SSE stream with `Last-Event-ID` resumability so clients can reconnect and replay missed events.

[`handlePostRequest()` in WorkerTransport](../packages/agents/src/mcp/worker-transport.ts#L404-L641) — batches requests, streams responses as SSE events, handles the request-ID→stream mapping.

**RPC transport** (agent-to-agent, no HTTP at all):

[`RPCClientTransport` and `RPCServerTransport`](../packages/agents/src/mcp/rpc.ts#L38-L317) — connect two agents via Durable Object RPC. The client sends JSON-RPC over `getServerByName()`; the server receives it via `handle()` and waits for a response within a 60-second timeout.

---

## Server side — HTTP handler factory

[`createMcpHandler()` in `handler.ts`](../packages/agents/src/mcp/handler.ts#L28-L121) — if you want to expose an MCP server from a plain Worker (not a Durable Object), use this. It creates a `WorkerTransport`, wires up CORS, and handles auth context injection. Returns an `async (request, env, ctx) => Response` function.

[`createStreamingHttpHandler()` in `utils.ts`](../packages/agents/src/mcp/utils.ts#L31-L500) — lower-level: creates the HTTP router that translates between web-standard `Request`/`Response` and the MCP SDK's Transport interface. `createMcpHandler()` delegates to this.

[`corsHeaders()` utility](../packages/agents/src/mcp/utils.ts#L501-L829) — applies `Access-Control-*` headers from a `CORSOptions` config.

---

## Client side — MCPClientManager

Your agent connects to external MCP servers through `MCPClientManager`. An instance lives at `this.mcp` on every `Agent` that has used `addMcpServer()`.

[`MCPClientManager` class](../packages/agents/src/mcp/client.ts#L266-L600) — manages a registry of named server connections backed by SQLite. Connections survive agent hibernation.

[`isBlockedUrl()` — SSRF protection](../packages/agents/src/mcp/client.ts#L133-L161) — blocks connections to private IPv4/IPv6 ranges, link-local addresses, loopback, and cloud metadata endpoints. Always called before opening a transport connection to a user-supplied URL.

[`MCPServerOptions` and `MCPConnectionResult`](../packages/agents/src/mcp/client.ts#L167-L216) — the options you pass when registering a server (transport type, headers, auth provider) and the discriminated union returned when a connection attempt completes.

[`registerServer()`](../packages/agents/src/mcp/client.ts#L350-L520) — stores server metadata in SQLite and opens the connection. Also initiates OAuth if `auth` is configured.

[`restoreConnectionsFromStorage()`](../packages/agents/src/mcp/client.ts#L521-L617) — called during `onStart()` to reconnect to all previously registered servers. This is what makes MCP connections survive hibernation.

[`getAITools()`](../packages/agents/src/mcp/client.ts#L618-L700) — aggregates tools from all `READY` servers into a single AI SDK `ToolSet`. Pass this to your `generateText()` / `streamText()` calls.

---

## Client side — MCPClientConnection

Each server connection is managed by a `MCPClientConnection` instance, which owns the state machine for a single server.

[`MCPConnectionState` enum](../packages/agents/src/mcp/client-connection.ts#L55-L68) — the states: `AUTHENTICATING → CONNECTING → DISCOVERING → READY → FAILED`. Every transition is logged to the observability channel.

[`MCPClientConnection` class](../packages/agents/src/mcp/client-connection.ts#L105-L816) — the connection lifecycle:

[`init()` — connection initiation](../packages/agents/src/mcp/client-connection.ts#L156-L204) — chooses the transport (probes streamable-HTTP first, falls back to SSE on 404/405), starts the OAuth flow if needed.

[`completeAuthorization()`](../packages/agents/src/mcp/client-connection.ts#L255-L272) — called after the OAuth callback. Resumes the connection from the `AUTHENTICATING` state.

[`discoverAndRegister()`](../packages/agents/src/mcp/client-connection.ts#L278-L365) — queries the server's capabilities and registers its tools, resources, prompts, and resource templates with the manager's tool registry.

[`discover()`](../packages/agents/src/mcp/client-connection.ts#L375-L450) — the discovery request itself, with configurable timeout and cancellation.

---

## OAuth storage (`do-oauth-client-provider.ts`)

[`DurableObjectOAuthClientProvider`](../packages/agents/src/mcp/do-oauth-client-provider.ts#L36-L258) — stores OAuth client info, access tokens, PKCE code verifiers, and CSRF state nonces in Durable Object storage. Nonces expire after 10 minutes. The storage key scheme is `/{clientName}/{serverId}/{field}`.

---

## X402 payment integration (`x402.ts`)

X402 is a micro-payment protocol that lets you gate tool calls behind a payment.

[`withX402(server, options)` augmentation](../packages/agents/src/mcp/x402.ts#L98-L294) — wraps an `McpServer` and adds a `paidTool()` method. When a paid tool is called without a valid payment receipt, it returns an `x402/error` response with payment instructions. After payment, the tool call is retried and the receipt is verified before execution.

[Payment verification and settlement](../packages/agents/src/mcp/x402.ts#L294-L502) — the full payment flow: extract the payment receipt from the MCP request `_meta` field, verify it against the payment processor, call the underlying tool if valid, and record the settlement. Network IDs are normalised via `normalizeNetwork()` (converts v1 names to CAIP-2 identifiers like `eip155:1`).

X402 is a micro-payment protocol that lets you gate tool calls behind a payment.

[`withX402(server, options)` augmentation](../packages/agents/src/mcp/x402.ts#L98-L294) — wraps an `McpServer` and adds a `paidTool()` method. When a paid tool is called without a valid payment receipt, it returns an `x402/error` response with payment instructions. After payment, the tool call is retried and the receipt is verified before execution.

---

## MCPClientManager internals

The `MCPClientManager` is the most complex part of the client side. This section covers the parts not already described above.

[`callTool()` method with retry logic](../packages/agents/src/mcp/client.ts#L618-L900) — executes a named tool on a connected server. Wraps the raw MCP `client.callTool()` call with configurable retry (default 3 attempts, exponential backoff). Returns the tool result or throws after all retries are exhausted.

[`getTools()` and per-server tool namespacing](../packages/agents/src/mcp/client.ts#L900-L1100) — aggregates tools from all `READY` servers. By default tools are namespaced with the server name (`serverName_toolName`) to avoid collisions. The `stripNamespace` option removes the prefix if you control the tool names.

[OAuth state management in `MCPClientManager`](../packages/agents/src/mcp/client.ts#L1100-L1400) — stores and retrieves per-server OAuth state. When a server requires auth, `registerServer()` stores an `AUTHENTICATING` state and returns an `authorizationUrl`. After the user authorises, `completeAuthorization()` is called with the callback URL.

[SQLite persistence schema](../packages/agents/src/mcp/client.ts#L1400-L1617) — the `cf_agents_mcp_servers` table schema and the read/write helpers. Each row stores: server name, transport type, URL, auth state, capabilities, and the last-connected timestamp.

[`MCPServerRow` type in `client-storage.ts`](../packages/agents/src/mcp/client-storage.ts#L1-L12) — the TypeScript type for the SQLite row above. A single flat object with all the persisted fields.

## Deprecated transport aliases

[`SSEEdgeClientTransport` and `StreamableHTTPEdgeClientTransport`](../packages/agents/src/mcp/client-transports.ts#L1-L42) — old names kept for backwards compatibility. They re-export the current transport classes with a deprecation warning. If you see these in older code, they map to the SSE and streamable-HTTP transports above.
