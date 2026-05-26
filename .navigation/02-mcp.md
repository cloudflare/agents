# 02 — Model Context Protocol (MCP)

MCP is the standard wire protocol for exposing tools, resources, and prompts to LLMs. This codebase implements both sides: an MCP **server** (your agent hosts tools that an LLM can call) and an MCP **client** (your agent connects to external servers to use their tools).

All MCP code lives in `packages/agents/src/mcp/`.

---

## Types and shared constants

[`TransportType`, `ServeOptions`, `CORSOptions`](../packages/agents/src/mcp/types.ts#L1-L25) — the four transport types (`"sse"`, `"streamable-http"`, `"rpc"`, `"auto"`), the config for serving a handler over HTTP (`ServeOptions`), and CORS configuration (`CORSOptions`). Also exports `McpClientOptions` and `MaybePromise`.

[`isUnauthorized()` and `isTransportNotImplemented()`](../packages/agents/src/mcp/errors.ts#L1-L39) — error classifiers used during transport negotiation. When a client tries streamable-HTTP and gets a 404/405, these tell the retry logic to fall back to SSE.

[`getMcpAuthContext()` and `runWithAuthContext()`](../packages/agents/src/mcp/auth-context.ts#L1-L15) — thin wrappers around `AsyncLocalStorage` that propagate OAuth credentials through the call stack without explicit parameter threading.

---

## Server side — McpAgent

`McpAgent` is the abstract base class for agents that *are* an MCP server. Extend it and implement `init()` to register your tools, resources, and prompts with an `McpServer` instance from the `@modelcontextprotocol/sdk` package.

[McpAgent class — fields, helpers, transport initialisation, and onStart() wiring](../packages/agents/src/mcp/index.ts#L30-L200) and [McpAgent — onConnect() request routing, onSSEMcpMessage(), and elicitInput() implementation](../packages/agents/src/mcp/index.ts#L200-L499) and [McpAgent — _handleElicitationResponse(), handleMcpMessage(), and the static serve()/serveSSE()/mount() factory methods plus module re-exports](../packages/agents/src/mcp/index.ts#L500-L553) — the full class. Key things to note:

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

[WorkerTransport — private fields, state restore/save, and request dispatch](../packages/agents/src/mcp/worker-transport.ts#L90-L270) and [WorkerTransport.handleGetRequest() — SSE stream setup and WebSocket relay](../packages/agents/src/mcp/worker-transport.ts#L270-L410) and [WorkerTransport.handlePostRequest() — JSON-RPC processing and response streaming](../packages/agents/src/mcp/worker-transport.ts#L410-L670) and [WorkerTransport.handleDeleteRequest(), validateSession(), close(), and send()](../packages/agents/src/mcp/worker-transport.ts#L670-L941) — similar to `StreamableHTTPServerTransport` but designed for stateless Workers. Persists session state to Durable Object storage (via `restoreState()` / `saveState()`) to survive request boundaries.

[`handleGetRequest()` in WorkerTransport](../packages/agents/src/mcp/worker-transport.ts#L270-L402) — sets up the SSE stream with `Last-Event-ID` resumability so clients can reconnect and replay missed events.

[`handlePostRequest()` in WorkerTransport](../packages/agents/src/mcp/worker-transport.ts#L404-L641) — batches requests, streams responses as SSE events, handles the request-ID→stream mapping.

**RPC transport** (agent-to-agent, no HTTP at all):

[`RPCClientTransport` and `RPCServerTransport`](../packages/agents/src/mcp/rpc.ts#L38-L317) — connect two agents via Durable Object RPC. The client sends JSON-RPC over `getServerByName()`; the server receives it via `handle()` and waits for a response within a 60-second timeout.

---

## Server side — HTTP handler factory

[`createMcpHandler()` in `handler.ts`](../packages/agents/src/mcp/handler.ts#L28-L121) — if you want to expose an MCP server from a plain Worker (not a Durable Object), use this. It creates a `WorkerTransport`, wires up CORS, and handles auth context injection. Returns an `async (request, env, ctx) => Response` function.

[createStreamingHttpHandler() — Accept/Content-Type validation, session ID handling, and POST path (body parsing, DO websocket bridging, SSE response)](../packages/agents/src/mcp/utils.ts#L31-L200) and [createStreamingHttpHandler() — POST path continuation (WebSocket event relay, 202 Accepted), GET path (standalone SSE stream), and DELETE path (session teardown)](../packages/agents/src/mcp/utils.ts#L200-L499) — lower-level: creates the HTTP router that translates between web-standard `Request`/`Response` and the MCP SDK's Transport interface. `createMcpHandler()` delegates to this.

[createLegacySseHandler() and createAutoHandler() — legacy SSE and auto-negotiating HTTP routing](../packages/agents/src/mcp/utils.ts#L501-L740) — `createLegacySseHandler()` handles the classic two-endpoint SSE pattern (GET for stream, POST to `/message`); `createAutoHandler()` wraps both handlers and dispatches based on request shape. [`corsHeaders()`, `handleCORS()`, and `isDurableObjectNamespace()`](../packages/agents/src/mcp/utils.ts#L740-L829) — CORS header builder, OPTIONS preflight responder, and a runtime type-guard that checks whether a binding is a `DurableObjectNamespace`.

---

## Client side — MCPClientManager

Your agent connects to external MCP servers through `MCPClientManager`. An instance lives at `this.mcp` on every `Agent` that has used `addMcpServer()`.

[MCPClientManager — constructor, SQL helpers, storage operations, connection filtering, and OAuth/auth-provider helpers](../packages/agents/src/mcp/client.ts#L266-L520) and [MCPClientManager — restoreConnectionsFromStorage()](../packages/agents/src/mcp/client.ts#L520-L620) — manages a registry of named server connections backed by SQLite. Connections survive agent hibernation.

[`isBlockedUrl()` — SSRF protection](../packages/agents/src/mcp/client.ts#L133-L161) — blocks connections to private IPv4/IPv6 ranges, link-local addresses, loopback, and cloud metadata endpoints. Always called before opening a transport connection to a user-supplied URL.

[`MCPServerOptions` and `MCPConnectionResult`](../packages/agents/src/mcp/client.ts#L167-L216) — the options you pass when registering a server (transport type, headers, auth provider) and the discriminated union returned when a connection attempt completes.

[`registerServer()`](../packages/agents/src/mcp/client.ts#L893-L932) — stores server metadata in SQLite and creates the in-memory connection object. Fires `onServerStateChanged` but does not connect; call `connectToServer()` afterwards.

[`restoreConnectionsFromStorage()`](../packages/agents/src/mcp/client.ts#L521-L618) — called during `onStart()` to reconnect to all previously registered servers. This is what makes MCP connections survive hibernation.

[`getAITools()`](../packages/agents/src/mcp/client.ts#L1319-L1381) — aggregates tools from all `READY` servers into a single AI SDK `ToolSet`. Wraps each tool's `execute` in a `callTool()` call and converts JSON Schema to Zod. Pass this to your `generateText()` / `streamText()` calls.

---

## Client side — MCPClientConnection

Each server connection is managed by a `MCPClientConnection` instance, which owns the state machine for a single server.

[`MCPConnectionState` enum](../packages/agents/src/mcp/client-connection.ts#L55-L68) — the states: `AUTHENTICATING → CONNECTING → DISCOVERING → READY → FAILED`. Every transition is logged to the observability channel.

[MCPClientConnection — fields, init(), finishAuthProbe(), and completeAuthorization()](../packages/agents/src/mcp/client-connection.ts#L105-L280) and [discoverAndRegister(), discover(), and cancelDiscovery()](../packages/agents/src/mcp/client-connection.ts#L280-L490) and [registerTools(), registerResources(), registerPrompts(), and elicitation handling](../packages/agents/src/mcp/client-connection.ts#L490-L640) and [Session metadata, close(), getTransport(), tryConnect(), and error handlers](../packages/agents/src/mcp/client-connection.ts#L640-L816) — the connection lifecycle:

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

[`withX402Client()` — X402 client-side payment handling](../packages/agents/src/mcp/x402.ts#L294-L502) — wraps an MCP `Client` to intercept `x402/error` responses. On a payment-required error, it builds a v2 payment payload (EVM signature via viem), re-calls the tool with the token in `_meta`, and enforces a configurable `maxPaymentValue` cap. Also wraps `listTools()` to annotate paid tools' descriptions with their USD price.

---

## MCPClientManager internals

The `MCPClientManager` is the most complex part of the client side. This section covers the parts not already described above.

[deprecated `connect()`, `createConnection()`, and connection tracking helpers](../packages/agents/src/mcp/client.ts#L618-L900) — the legacy `connect()` combines register + connect + discover in one call and is kept for backwards compatibility; `createConnection()` is the internal factory that creates an `MCPClientConnection` object and wires up observability events; `_restoreServer()`, `_trackConnection()`, and `waitForConnections()` manage the in-flight connection map used by hibernation recovery.

[`connectToServer()`, `isCallbackRequest()`, and `validateCallbackRequest()`](../packages/agents/src/mcp/client.ts#L900-L1100) — `connectToServer()` initiates transport connection on an already-registered server and returns a discriminated-union result (`connected`, `authenticating`, or `failed`); `isCallbackRequest()` and `validateCallbackRequest()` match and validate incoming OAuth redirect requests before the token exchange.

[`handleCallbackRequest()`, `discoverIfConnected()`, and `establishConnection()`](../packages/agents/src/mcp/client.ts#L1100-L1300) — `handleCallbackRequest()` completes the OAuth flow after the user returns from the provider; `discoverIfConnected()` triggers capability discovery and transitions the connection to `READY`; `establishConnection()` is a convenience wrapper for post-OAuth reconnect.

[`getOAuthCallbackConfig()`, `listTools()`, and `getAITools()`](../packages/agents/src/mcp/client.ts#L1300-L1400) — configuration accessor for OAuth callbacks and tool aggregation entry points. `getAITools()` is the main method consumers call; `listTools()` returns raw tool metadata without the AI SDK wrapper.

[Connection teardown and namespaced capability accessors](../packages/agents/src/mcp/client.ts#L1400-L1617) — `cleanupClosedConnection()`, `closeAllConnections()`, `closeConnection()`, `removeServer()`, `listServers()`, and `dispose()` manage the connection lifecycle; `listPrompts()`, `listResources()`, `listResourceTemplates()`, `callTool()`, `readResource()`, and `getPrompt()` are the namespaced per-capability accessors; `getNamespacedData()` is the shared helper that attaches `serverId` to every capability item.

[`MCPServerRow` type in `client-storage.ts`](../packages/agents/src/mcp/client-storage.ts#L1-L12) — the TypeScript type for the SQLite row above. A single flat object with all the persisted fields.

## Deprecated transport aliases

[`SSEEdgeClientTransport` and `StreamableHTTPEdgeClientTransport`](../packages/agents/src/mcp/client-transports.ts#L1-L42) — old names kept for backwards compatibility. They re-export the current transport classes with a deprecation warning. If you see these in older code, they map to the SSE and streamable-HTTP transports above.
