# Connecting to MCP Servers

Connect your agent to external MCP (Model Context Protocol) servers to use their tools, resources, and prompts. This enables your agent to interact with GitHub, Slack, databases, and other services through a standardized protocol.

## Overview

The MCP client capability lets your agent:

- **Connect to external MCP servers** - GitHub, Slack, databases, AI services
- **Use their tools** - Call functions exposed by MCP servers
- **Access resources** - Read data from MCP servers
- **Use prompts** - Leverage pre-built prompt templates

> **Note:** This page covers connecting to MCP servers as a client. To create your own MCP server, see [Creating MCP Servers](./mcp-servers.md).

## Compose the MCP client with a Durable Object

`MCPClientManager` is a lifecycle capability. A class can extend the platform
`DurableObject` directly and install the manager without extending `Agent`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { MCPClientManager } from "agents/mcp/client";

export class MyObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("my-object", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  onRequest() {
    return Response.json({ tools: this.mcp.listTools() });
  }
}
```

The lifecycle calls the manager automatically:

- `onStart()` initializes its schema and starts restoring persisted HTTP and
  RPC connections in the background, so startup never waits on an MCP server.
  Use `waitForConnections()` when you need restored tools.
- `onRequest()` intercepts registered OAuth callback URLs before the host's
  request handler.

Do not call these hooks manually. For a native Durable Object RPC method,
which bypasses `fetch`, call `await this.lifecycle.start()` before using the
manager. Explicit cleanup remains available through `mcp.dispose()`; Durable
Objects do not provide an eviction callback.

The manager does not require a particular OAuth callback route. Pass the exact
callback URL to `registerServer()` and route that request to the same named
Durable Object. The manager persists the URL and only intercepts a callback
whose origin and pathname match it.

`Agent` installs this same capability object directly. Existing `this.mcp`,
`addMcpServer()`, `removeMcpServer()`, and `getMcpServers()` APIs remain
available.

## Quick Start

Install the exact MCP client peer used by this Agents release:

```sh
pnpm add agents @modelcontextprotocol/client@2.4.0
```

The MCP client does not need `@modelcontextprotocol/sdk` or `@modelcontextprotocol/server`. Those packages are optional peers used only by the MCP server APIs.

```typescript
import { Agent } from "agents";

export class MyAgent extends Agent {
  async onRequest(request: Request) {
    // Add an MCP server
    const result = await this.addMcpServer(
      "github",
      "https://mcp.github.com/mcp"
    );

    if (result.state === "authenticating") {
      // Server requires OAuth - redirect user to authorize
      return Response.redirect(result.authUrl);
    }

    // Server is ready - tools are now available
    const state = this.getMcpServers();
    console.log(`Connected! ${state.tools.length} tools available`);

    return new Response("MCP server connected");
  }
}
```

## Adding MCP Servers

Use `addMcpServer()` to connect to an MCP server:

```typescript
const result = await this.addMcpServer(name, url, options?);
```

### Basic Usage

```typescript
// Simple connection
await this.addMcpServer("notion", "https://mcp.notion.so/mcp");

// With explicit callback host (rarely needed — auto-derived from request or WebSocket URI)
await this.addMcpServer("github", "https://mcp.github.com/mcp", {
  callbackHost: "https://my-worker.workers.dev"
});
```

### Transport Options

MCP supports multiple transport types:

```typescript
await this.addMcpServer("server", "https://mcp.example.com/mcp", {
  transport: {
    // Transport type: "streamable-http" (default), "sse", or "auto"
    type: "streamable-http"
  }
});
```

| Transport           | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `"streamable-http"` | HTTP with streaming - recommended default             |
| `"sse"`             | Server-Sent Events - legacy / compatibility transport |
| `"auto"`            | Auto-detect based on server response                  |

### Custom Headers

For servers behind authentication (like Cloudflare Access) or using bearer tokens:

```typescript
await this.addMcpServer("internal", "https://internal-mcp.example.com/mcp", {
  transport: {
    headers: {
      Authorization: "Bearer my-token",
      "CF-Access-Client-Id": "...",
      "CF-Access-Client-Secret": "..."
    }
  }
});
```

### Legacy OAuth metadata compatibility

SDK v2 validates authorization-server metadata issuers by default. A trusted Legacy server with known mismatched RFC 8414 metadata can opt out explicitly:

```typescript
await this.addMcpServer("legacy", "https://legacy.example.com/mcp", {
  transport: {
    skipIssuerMetadataValidation: true
  }
});
```

This weakens OAuth mix-up protection. Do not enable it for unknown servers or as a general fallback.

### Retry Options

Configure retry behavior for connection and reconnection attempts:

```typescript
await this.addMcpServer("github", "https://mcp.github.com/mcp", {
  retry: {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 10000
  }
});
```

These options are persisted and used when reconnecting after hibernation or after OAuth completion. Default: 3 attempts, 500ms base delay, 5s max delay. See [Retries](./retries.md) for more details.

### Automatic reconnects

When a connection or discovery attempt fails (the server is down, times out, or returns an error), the manager keeps trying in the background on a schedule stored in the Durable Object's job queue, so it survives hibernation and eviction: after 30 seconds, 1, 2, 5 and 10 minutes, then every 30 minutes. The server shows `failed` with the last error in between, including after a wake for some other reason: the agent waits for the scheduled attempt rather than connecting early. Once it connects, the schedule is dropped.

Retrying only helps when the failure can pass, so the manager does not retry when authorization was refused:

- The server answered `401` and the agent cannot ask the user, for example a revoked static token passed in `transport.headers`, or no OAuth callback configured. When it can ask, the server moves to `authenticating` with a new link instead.
- The server answered `403`. A `403` with `error="insufficient_scope"` still starts a [step-up](#re-authorization-during-a-session) first; it only counts as refused when no step-up is possible.
- The authorization server refused with an OAuth error such as `invalid_target`, `invalid_scope` or `access_denied`. An expired or revoked refresh token (`invalid_grant`) starts a new authorization instead. `server_error` and `temporarily_unavailable` are retried like any other outage.

- The authorization server rejected dynamic client registration with a `4xx` other than `429`.
- The server still answers `401` right after the user completed an authorization, for example because it rejects tokens from its own authorization server. The link that was just used is never shown again.

The server is marked `failed` with `Authorization was refused: …`, and the failure is recorded the same way as below.

A callback where the user denied access, or whose code could not be exchanged, is recorded too, so a later wake does not start another flow the user just turned down. An authorization link stays pending for at most 24 hours, even when a custom OAuth provider would still accept its `state`.

After 24 hours without a successful connection, the manager stops and records the failure with the server. Later wakes show the same `failed` state without trying again. `removeMcpServer()` cancels any pending reconnect.

#### Reconnecting on request

Calling `addMcpServer()` for a server that is already registered reconnects it if it isn't connected, so calling it from `onStart`, `onConnect` or `onRequest` brings a server back once it can be reached:

- `ready`, or a link still waiting for the user: returned as is.
- `failed` from something that can pass (network, `5xx`, timeout) or a link that expired unused: connects now and returns the result, including a fresh `authUrl`. It tries at most once per first backoff step (30 seconds by default); a call sooner than that throws the current error.
- `failed` for a reason only a person can fix (authorization was refused or denied, the step-up limit was reached, or reconnecting gave up after 24 hours): throws that reason without trying again.

To try any failed server again because the user asked, for example from a "Reconnect" button, call `reconnectMcpServer(id)`. It forgets why the server stopped, drops pending reconnects and connects now, with no rate limit. It returns the same result as `addMcpServer()`, including a fresh `authUrl` when the user needs to authorize again.

```typescript
import { Agent, callable } from "agents";

class MyAgent extends Agent<Env> {
  @callable()
  async reconnectServer(id: string) {
    return this.reconnectMcpServer(id);
  }
}
```

A standalone `MCPClientManager` can change the schedule:

```typescript
new MCPClientManager("my-client", "1.0.0", {
  reconnect: {
    delaysMs: [10_000, 60_000, 600_000], // the last delay repeats
    giveUpAfterMs: 6 * 60 * 60 * 1000
  }
});
```

### Protocol negotiation and elicitation

Agents uses the MCP v2 client and automatically negotiates the protocol version for every connection. It uses `server/discover` with Stateless servers and falls back to the `initialize` handshake on the same connection for Legacy Streamable HTTP and SSE servers.

MCP servers can request input from the client during `callTool`, `getPrompt`, or `readResource`. Stateless Elicitation returns an `input_required` result and completes through MRTR: the MCP SDK invokes the configured `elicitation/create` handler, sends its response, and continues the original request. Agents does not expose an intermediate continuation; the original call stays pending while human input is collected and eventually resolves to the ordinary tool, prompt, or resource result. Legacy Elicitation on Legacy servers continues to use pushed `elicitation/create` requests. Both generations share the same handlers.

Configure elicitation handlers before MCP connections are registered or restored:

```typescript
import { Agent } from "agents";

class MyAgent extends Agent<Env> {
  onStart() {
    this.mcp.configureElicitationHandlers({
      url: async (request, serverId) => {
        // Deliver a url-mode elicitation link out-of-band
        return { action: "accept" as const, content: {} };
      },
      form: async (request, serverId) => {
        // Collect values matching request.params.requestedSchema
        return { action: "accept" as const, content: {} };
      }
    });
  }
}
```

The advertised modes are persisted with each MCP server, so a connection restored from storage after hibernation re-advertises the same modes at the handshake; the handlers themselves re-attach when `onStart()` runs. Configuring a handler after an MCP connection is already active updates the in-memory handler, but the server only sees new advertised elicitation modes after that connection reconnects.

Handlers and pending calls are memory-only. A Durable Object hibernation or isolate restart does not preserve an in-flight interactive call; callers must retry it after the connection is restored. Agents intentionally does not persist in-flight Stateless `requestState` or implement a manual/resumable continuation layer.

Connections advertise only the elicitation modes with configured handlers at the `initialize` handshake: configure `form` to advertise form-mode elicitation, `url` to advertise url-mode elicitation (MCP spec 2025-11-25 — url mode is used for sensitive flows like OAuth URLs), or both to advertise both modes. Without handlers, connections advertise no elicitation capability, so spec-compliant servers use their non-elicitation fallbacks instead of sending requests the agent cannot answer.

To override the advertised modes, declare them explicitly — an explicit declaration always wins and is persisted with the server options, surviving hibernation:

```typescript
await this.addMcpServer("portal", "https://portal.example.com/mcp", {
  client: {
    capabilities: {
      elicitation: { form: {} } // form-mode only, even with both handlers configured
    }
  }
});
```

### URL Security

MCP server URLs are validated before connection to prevent Server-Side Request Forgery (SSRF). The following URL targets are blocked:

- Private/internal IP ranges (RFC 1918: `10.x`, `172.16-31.x`, `192.168.x`)
- Unspecified addresses (`0.0.0.0`, `::`)
- Link-local addresses (`169.254.x`, `fe80::`)
- Cloud metadata endpoints (`169.254.169.254`)
- IPv6 unique-local addresses (`fc00::/7`)

Loopback development URLs such as `localhost`, `127.0.0.1`, and `::1` are allowed.

### Return Value

`addMcpServer()` returns the connection state:

```typescript
type AddMcpServerResult =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string };
```

- **`ready`** - Server connected and tools discovered
- **`authenticating`** - Server requires OAuth; redirect user to `authUrl`. This includes servers that accept the MCP handshake without a token but require one to list tools, prompts or resources.

Calling `addMcpServer()` again for a server that is already registered returns its current state, and reconnects it when it isn't connected (see [Reconnecting on request](#reconnecting-on-request)). If the server is still connecting (for example while it is restored after the agent wakes), the call waits for that attempt and returns its result. Pass a stable `id` so the server keeps the same id everywhere.

### Best practices

- Add servers with a stable `id`, from a callable the user triggers or from `onStart`.
- Render each server from `getMcpServers()` (`onMcpUpdate` in `useAgent`): send the user to `auth_url` while it is `authenticating`, and show `error` with a **Reconnect** button that calls `reconnectMcpServer(id)` while it is `failed`.
- Catch [`MCPAuthorizationRequiredError`](#re-authorization-during-a-session) from `callTool()`, `readResource()` and `getPrompt()`, and give the user `error.authUrl`.
- In a plain `Agent`, call [`waitForConnections()`](#waiting-for-connections) before relying on restored tools. `AIChatAgent` and Think already do.
- Close the OAuth popup with [`configureOAuthCallback()`](#oauth-authentication).

## OAuth Authentication

Many MCP servers require OAuth authentication. The agent handles the OAuth flow automatically.

### How It Works

```mermaid
sequenceDiagram
    participant Client
    participant Agent
    participant MCPServer

    Client->>Agent: addMcpServer(name, url)
    Agent->>MCPServer: Connect
    MCPServer-->>Agent: Requires OAuth
    Agent-->>Client: state: authenticating, authUrl
    Client->>MCPServer: User authorizes
    MCPServer->>Agent: Callback with code
    Agent->>MCPServer: Exchange for token
    Agent-->>Client: onMcpUpdate (ready)
```

### Handling OAuth in Your Agent

```typescript
async onRequest(request: Request) {
  const result = await this.addMcpServer("github", "https://mcp.github.com/mcp");

  if (result.state === "authenticating") {
    // Option 1: Redirect the user
    return Response.redirect(result.authUrl);

    // Option 2: Return the URL for client-side redirect
    return Response.json({
      status: "needs_auth",
      authUrl: result.authUrl
    });
  }

  return Response.json({ status: "connected", id: result.id });
}
```

### OAuth Callback

The callback URL is automatically constructed:

```
https://{host}/{agentsPrefix}/{agent-name}/{instance-name}/callback
```

For example: `https://my-worker.workers.dev/agents/my-agent/default/callback`

OAuth tokens are securely stored in SQLite and persist across agent restarts.

An authorization link stays valid for 10 minutes. If the user does not complete it in time, the server moves to `failed` with the error "Authorization expired before it was completed", its `auth_url` is cleared, and it stays failed across wakes. Call `reconnectMcpServer(id)` to get a fresh link. If a callback already redeemed the link and the agent restarted before it finished, the agent reconnects with the saved tokens instead.

### Re-authorization during a session

A request can need authorization again after the server is `ready`: a tool call that needs a scope the grant lacks (`403 insufficient_scope`), or a `401` whose token refresh fails. `callTool()`, `readResource()` and `getPrompt()` then throw `MCPAuthorizationRequiredError`. The server moves to `authenticating` and its `auth_url` is saved, so clients see the new link through `getMcpServers()` like at connect time. Send the user to `error.authUrl`; the normal OAuth callback completes the flow and reconnects. Retry the request when the server is `ready` again. Tools from `getAITools()` call `callTool()`, so their `execute` throws the same error. If no usable link was produced (for example, a custom OAuth provider that does not put a fresh `state` in each authorization URL, or a callback for this server is already being processed), the call throws the SDK's plain `UnauthorizedError` as before. `MCPAuthorizationRequiredError` extends `UnauthorizedError`, so existing `instanceof UnauthorizedError` checks keep matching.

Calls for a `serverId` with no connection (never registered, removed, or still being restored) throw `MCPConnectionNotFoundError`.

Re-authorization is limited, as the MCP authorization spec asks. If the user completes three authorizations for the same scopes within an hour and the server still asks for them (for example because the authorization server never grants a scope), the next challenge does not produce a link. The server moves to `failed` with an error naming the scopes, the request throws the SDK's `UnauthorizedError`, and the server stays failed until you call `reconnectMcpServer(id)`.

```typescript
import { MCPAuthorizationRequiredError } from "agents/mcp/client";

try {
  return await this.mcp.callTool({ serverId, name: "deploy", arguments: {} });
} catch (error) {
  if (error instanceof MCPAuthorizationRequiredError) {
    return { needsAuthorization: true, authUrl: error.authUrl };
  }
  throw error;
}
```

### Custom Callback Handling

For custom OAuth completion behavior:

```typescript
// In your agent constructor or onStart
this.mcp.configureOAuthCallback({
  // Redirect after successful auth
  successRedirect: "https://myapp.com/success",

  // Redirect on error
  errorRedirect: "https://myapp.com/error",

  // Or use a custom handler
  customHandler: (result) => {
    return new Response(
      JSON.stringify({
        success: result.authSuccess,
        serverId: result.serverId,
        error: result.authError
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }
});
```

### Custom OAuth Provider

By default, agents use dynamic client registration to authenticate with MCP servers. If you need to use a different OAuth strategy — such as pre-registered client credentials, mTLS-based authentication, or other mechanisms — override the `createMcpOAuthProvider` method in your agent subclass:

```typescript
import { Agent } from "agents";
import type { AgentMcpOAuthProvider } from "agents";

class MyAgent extends Agent {
  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new MyCustomOAuthProvider(this.ctx.storage, this.name, callbackUrl);
  }
}
```

Your custom class must implement the `AgentMcpOAuthProvider` interface, which extends the MCP SDK's `OAuthClientProvider` with additional properties (`authUrl`, `clientId`, `serverId`) and methods (`checkState`, `consumeState`, `deleteCodeVerifier`) used by the agent's MCP connection lifecycle.

The override is used for both new connections (`addMcpServer`) and restored connections after a Durable Object restart, so your custom provider is always used consistently.

#### Custom storage backend

The most common customization is using a different storage backend while keeping the built-in OAuth logic (CSRF state, PKCE, nonce generation, token management). Import `DurableObjectOAuthClientProvider` and pass your own storage adapter:

```typescript
import { Agent, DurableObjectOAuthClientProvider } from "agents";
import type { AgentMcpOAuthProvider } from "agents";

class MyAgent extends Agent {
  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(
      myCustomStorage, // any DurableObjectStorage-compatible adapter
      this.name,
      callbackUrl
    );
  }
}
```

#### Client ID Metadata Documents

Some authorization servers accept a [Client ID Metadata Document](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#client-id-metadata-documents) instead of dynamic client registration. Pass `clientMetadataUrl` to use one. When a server advertises `client_id_metadata_document_supported`, the agent sends that URL as its `client_id`. Servers that don't advertise it still get dynamic client registration.

```typescript
import { Agent, DurableObjectOAuthClientProvider } from "agents";
import type { AgentMcpOAuthProvider } from "agents";

class MyAgent extends Agent {
  createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(
      this.ctx.storage,
      this.name,
      callbackUrl,
      { clientMetadataUrl: "https://my-app.example.com/oauth/client.json" }
    );
  }
}
```

Serve the document at that URL. `provider.clientMetadataDocument` returns its JSON: `client_id` is the URL and `redirect_uris` holds the callback URL. The authorization server checks every redirect URI against the document, so pass a fixed `callbackPath` to `addMcpServer` rather than relying on the per-instance default.

## Using MCP Capabilities

Once connected, access the server's capabilities:

### Getting Available Tools

Use `listTools()` when you need to discover or inspect the raw MCP catalog without preparing tools for an AI SDK model call:

```typescript
const tools = this.mcp.listTools();

for (const tool of tools) {
  console.log(`Tool: ${tool.name}`);
  console.log(`  From server: ${tool.serverId}`);
  console.log(`  Description: ${tool.description}`);
}
```

`getMcpServers().tools` exposes the same raw tool shape as part of the full client state sent to connected applications. Neither API converts JSON Schemas to Zod.

### Resources and Prompts

```typescript
const state = this.getMcpServers();

// Available resources
for (const resource of state.resources) {
  console.log(`Resource: ${resource.name} (${resource.uri})`);
}

// Available prompts
for (const prompt of state.prompts) {
  console.log(`Prompt: ${prompt.name}`);
}
```

### Server Status

```typescript
const state = this.getMcpServers();

for (const [id, server] of Object.entries(state.servers)) {
  console.log(`${server.name}: ${server.state}`);
  // state: "ready" | "authenticating" | "connecting" | "connected" | "discovering" | "failed"
}
```

### Integration with AI SDK

To use MCP tools with the Vercel AI SDK, use `this.mcp.getAITools()` which converts MCP tools to AI SDK format:

```typescript
import { generateText } from "ai";

async function chat(prompt: string) {
  const response = await generateText({
    model: openai("gpt-4"),
    prompt,
    tools: this.mcp.getAITools() // Converts MCP tools to AI SDK format
  });

  return response;
}
```

> **Note:** Use `this.mcp.listTools()` or `getMcpServers().tools` for discovery and inspection. Call `this.mcp.getAITools()` only when preparing tools for the AI SDK because it converts each MCP input and output JSON Schema to Zod.

### AI tool schema conversion lifetime

`getAITools()` reuses converted schemas while a live connection keeps the same current catalog. Repeated filtered or unfiltered calls still return fresh tool records and execute closures. Connections excluded by a filter are not converted.

The next call converts schemas again after discovery replaces a catalog or the live connection changes. If a custom integration mutates a schema, assign a new `inputSchema` or `outputSchema` object, or replace the catalog array, so `getAITools()` detects the change.

## Managing Servers

### Removing a Server

```typescript
await this.removeMcpServer(serverId);
```

This disconnects from the server and removes it from storage.

### Persistence

MCP servers persist across agent restarts:

- Server configuration stored in SQLite
- OAuth tokens stored securely
- Connections restored automatically when agent wakes

### Listing All Servers

```typescript
const state = this.getMcpServers();

for (const [id, server] of Object.entries(state.servers)) {
  console.log(`${id}: ${server.name} (${server.server_url})`);
}
```

## Client-Side Integration

Connected clients receive real-time MCP updates via WebSocket:

```typescript
import { useAgent } from "agents/react";

function Dashboard() {
  const [tools, setTools] = useState([]);
  const [servers, setServers] = useState({});

  // reconnectServer is a @callable() that calls this.reconnectMcpServer(id)
  const agent = useAgent({
    agent: "MyAgent",
    onMcpUpdate: (mcpState) => {
      setTools(mcpState.tools);
      setServers(mcpState.servers);
    },
  });

  return (
    <div>
      <h2>Connected Servers</h2>
      {Object.entries(servers).map(([id, server]) => (
        <div key={id}>
          {server.name}: {server.state}
          {server.state === "authenticating" && server.auth_url && (
            <a href={server.auth_url} target="_blank">
              Authorize
            </a>
          )}
          {server.state === "failed" && (
            <>
              {server.error}
              <button onClick={() => agent.call("reconnectServer", [id])}>
                Reconnect
              </button>
            </>
          )}
        </div>
      ))}

      <h2>Available Tools ({tools.length})</h2>
      {tools.map((tool) => (
        <div key={`${tool.serverId}-${tool.name}`}>{tool.name}</div>
      ))}
    </div>
  );
}
```

## Advanced: MCPClientManager

For fine-grained control, use `this.mcp` directly:

### Step-by-Step Connection

```typescript
// 1. Register the server (saves to storage and creates in-memory connection)
const id = "my-server";
await this.mcp.registerServer(id, {
  url: "https://mcp.example.com/mcp",
  name: "My Server",
  callbackUrl: "https://my-worker.workers.dev/agents/my-agent/default/callback",
  transport: { type: "auto" }
});

// 2. Connect (initializes transport, handles OAuth if needed)
const connectResult = await this.mcp.connectToServer(id);

if (connectResult.state === "failed") {
  console.error("Connection failed:", connectResult.error);
  return;
}

if (connectResult.state === "authenticating") {
  console.log("OAuth required:", connectResult.authUrl);
  return;
}

// 3. Discover capabilities (transitions from "connected" to "ready")
if (connectResult.state === "connected") {
  const discoverResult = await this.mcp.discoverIfConnected(id);

  if (!discoverResult?.success) {
    console.error("Discovery failed:", discoverResult?.error);
  }
}
```

Connection work for one server runs one operation at a time: `connectToServer()`, `discoverIfConnected()`, `establishConnection()`, OAuth callback handling and restore for the same server wait for each other instead of interleaving. Work for different servers runs in parallel.

### Event Subscription

```typescript
// Listen for state changes (onServerStateChanged is an Event<void>)
const disposable = this.mcp.onServerStateChanged(() => {
  console.log("MCP server state changed");
  this.broadcastMcpServers(); // Notify connected clients
});

// Clean up the subscription when no longer needed
// disposable.dispose();
```

### Waiting for Connections

After hibernation or when connections are being restored in the background, MCP tools may not be immediately available. This applies to HTTP and RPC servers alike. Use `waitForConnections()` to wait until all in-flight connection and discovery operations have settled:

```typescript
// Wait indefinitely for all connections to be ready
await this.mcp.waitForConnections();

// Wait with a timeout (in milliseconds)
await this.mcp.waitForConnections({ timeout: 10_000 });
```

This is useful when you need to call `this.mcp.getAITools()` immediately after the agent wakes from hibernation. Without waiting, tools from servers that are still reconnecting will be missing.

> **Note:** `AIChatAgent` handles this automatically via the `waitForMcpConnections` property (defaults to `{ timeout: 10_000 }`). You only need `waitForConnections()` directly when using `Agent` with MCP, or when you want finer control inside `onChatMessage`.

### Error Recovery

On an `Agent`, retry a failed server with [`reconnectMcpServer(id)`](#reconnecting-on-request). On a standalone manager, `connectToServer()` is the explicit retry: it clears a recorded failure and the step-up budget before connecting.

```typescript
async retryConnection(serverId: string) {
  const result = await this.mcp.connectToServer(serverId);

  if (result.state === "connected") {
    await this.mcp.discoverIfConnected(serverId);
  } else if (result.state === "failed") {
    console.error("Reconnection failed:", result.error);
  }
}
```

## Examples

### MCP Client Demo

The [`examples/mcp-client`](https://github.com/cloudflare/agents/tree/main/examples/mcp-client) example demonstrates:

- Adding and removing MCP servers dynamically
- Custom OAuth callback handling (popup-closing behavior)
- Listing tools from connected servers
- Real-time state updates to the frontend

```typescript
// From examples/mcp-client/src/server.ts
export class MyAgent extends Agent {
  onStart() {
    // Custom OAuth callback that closes the popup window
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" }
          });
        }
        // Handle error...
      }
    });
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("add-mcp")) {
      const { name, url } = await request.json();
      await this.addMcpServer(name, url);
      return new Response("Ok");
    }
    // ...
  }
}
```

## API Reference

### addMcpServer()

```typescript
// HTTP transport (Streamable HTTP, SSE)
async addMcpServer(
  name: string,
  url: string,
  options?: {
    callbackHost?: string;  // auto-derived from request or WebSocket connection URI; only set to override
    callbackPath?: string;  // custom callback URL path (bypasses default /agents/{class}/{name}/callback)
    agentsPrefix?: string;
    client?: ClientOptions;
    transport?: {
      headers?: HeadersInit;
      type?: "sse" | "streamable-http" | "auto"; // default: "auto"
    };
    retry?: RetryOptions; // retry options for connection/reconnection
  }
): Promise<
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string }
>

// Legacy signature (still supported)
async addMcpServer(
  name: string,
  url: string,
  callbackHost?: string,
  agentsPrefix?: string,
  options?: { ... }
): Promise<...>
```

Add and connect to an MCP server. Throws if connection or discovery fails.

`callbackHost` is automatically derived from the incoming HTTP request or WebSocket connection URI — you almost never need to set it explicitly. It is only needed when the auto-detected host does not match your desired OAuth callback origin (for example, behind a reverse proxy). See [MCP Transports](./mcp-transports.md) for the transport options.

Calling `addMcpServer` is idempotent when both the server name **and** URL match an existing active connection — the existing connection is returned without creating a duplicate. This makes it safe to call in `onStart()` without worrying about duplicate connections on restart.

If you call `addMcpServer` with the same name but a **different** URL, a new connection is created. Both connections remain active and their tools are merged in `getAITools()`. To replace a server, call `removeMcpServer(oldId)` first.

> **Note:** URLs are normalized before comparison (trailing slashes, default ports, and hostname case are handled), so `https://MCP.Example.com` and `https://mcp.example.com/` are treated as the same URL.

### removeMcpServer()

```typescript
async removeMcpServer(id: string): Promise<void>
```

Disconnect from and remove an MCP server.

### getMcpServers()

```typescript
getMcpServers(): MCPServersState
```

Get the current state of all MCP servers and their capabilities.

### MCPServersState

```typescript
type MCPServersState = {
  servers: {
    [id: string]: MCPServer;
  };
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
};
```

### MCPServer

```typescript
type MCPServer = {
  name: string;
  server_url: string;
  auth_url: string | null;
  state:
    | "ready"
    | "authenticating"
    | "connecting"
    | "connected"
    | "discovering"
    | "failed";
  error: string | null;
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};
```
