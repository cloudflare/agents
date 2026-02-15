# Connecting to MCP Servers

Connect your agent to external MCP (Model Context Protocol) servers to use their tools, resources, and prompts. This enables your agent to interact with GitHub, Slack, databases, and other services through a standardized protocol.

## Overview

The MCP client capability lets your agent:

- **Connect to external MCP servers** - GitHub, Slack, databases, AI services
- **Use their tools** - Call functions exposed by MCP servers
- **Access resources** - Read data from MCP servers
- **Use prompts** - Leverage pre-built prompt templates

> **Note:** This page covers connecting to MCP servers as a client. To create your own MCP server, see [Creating MCP Servers](./mcp-servers.md).

## Quick Start

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

// With explicit callback host
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

### Return Value

`addMcpServer()` returns the connection state:

```typescript
type AddMcpServerResult =
  | { id: string; state: "ready" }
  | { id: string; state: "authenticating"; authUrl: string };
```

- **`ready`** - Server connected and tools discovered
- **`authenticating`** - Server requires OAuth; redirect user to `authUrl`

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

## Using MCP Capabilities

Once connected, access the server's capabilities:

### Getting Available Tools

```typescript
const state = this.getMcpServers();

// All tools from all connected servers
for (const tool of state.tools) {
  console.log(`Tool: ${tool.name}`);
  console.log(`  From server: ${tool.serverId}`);
  console.log(`  Description: ${tool.description}`);
}
```

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
  console.log(`${server.name}: ${server.connectionState}`);
  // connectionState: "ready" | "authenticating" | "connecting" | "not-connected"
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

> **Note:** `getMcpServers().tools` returns raw MCP `Tool` objects for inspection. Use `this.mcp.getAITools()` when passing tools to the AI SDK.

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

  const agent = useAgent({
    agent: "MyAgent",
    onMcpUpdate: (mcpState) => {
      setTools(mcpState.tools);
      setServers(mcpState.servers);
    }
  });

  return (
    <div>
      <h2>Connected Servers</h2>
      {Object.entries(servers).map(([id, server]) => (
        <div key={id}>
          {server.name}: {server.connectionState}
        </div>
      ))}

      <h2>Available Tools ({tools.length})</h2>
      {tools.map(tool => (
        <div key={`${tool.serverId}-${tool.name}`}>
          {tool.name}
        </div>
      ))}
    </div>
  );
}
```

## Advanced: MCPClientManager

For fine-grained control, use `this.mcp` directly:

### Step-by-Step Connection

```typescript
// 1. Register the server
await this.mcp.registerServer(id, {
  url: "https://mcp.example.com/mcp",
  name: "My Server",
  callbackUrl: "https://my-worker.workers.dev/agents/my-agent/default/callback",
  transport: { type: "auto" }
});

// 2. Connect
const connectResult = await this.mcp.connectToServer(id);

if (connectResult.state === "failed") {
  console.error("Connection failed:", connectResult.error);
  return;
}

if (connectResult.state === "authenticating") {
  // Handle OAuth...
  return;
}

// 3. Discover capabilities
const discoverResult = await this.mcp.discoverIfConnected(id);

if (!discoverResult?.success) {
  console.error("Discovery failed:", discoverResult?.error);
}
```

### Event Subscription

```typescript
// Listen for state changes
this.mcp.onServerStateChanged(() => {
  console.log("MCP server state changed");
  this.broadcastMcpServers(); // Notify connected clients
});
```

### Error Recovery

```typescript
async retryConnection(serverId: string) {
  // Retry connection for a registered server
  const result = await this.mcp.connectToServer(serverId);

  if (result.state === "connected") {
    await this.mcp.discoverIfConnected(serverId);
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
// Preferred signature
async addMcpServer(
  name: string,
  url: string,
  options?: {
    callbackHost?: string;
    agentsPrefix?: string;
    client?: ClientOptions;
    transport?: {
      headers?: HeadersInit;
      type?: "sse" | "streamable-http" | "auto"; // default: "streamable-http"
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
  connectionState: "ready" | "authenticating" | "connecting" | "not-connected";
  tools?: Tool[];
  resources?: Resource[];
  prompts?: Prompt[];
};
```
