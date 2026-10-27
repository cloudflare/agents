# Creating MCP Servers

Build an MCP server on Workers with `createMcpHandler` from `agents/mcp/server` and an MCP SDK v2 `McpServer`. The handler is stateless: every request gets a fresh server from your factory, so there is no Durable Object, session, or WebSocket to manage. It serves draft MCP `2026-07-28` and stateless 2025-era clients from the same endpoint.

## Install

```sh
pnpm add agents @modelcontextprotocol/server@2.4.0 zod
```

`@modelcontextprotocol/server` is an optional peer dependency of `agents`, so your package manager does not install it for you. Use the exact version required by your installed Agents release.

Upgrading a server that uses `McpAgent`? See [Upgrading an existing `McpAgent` server](#upgrading-an-existing-mcpagent-server).

## Create a server

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Hello MCP Server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting message",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => ({
      content: [{ text: `Hello, ${name ?? "World"}!`, type: "text" }]
    })
  );

  return server;
}

const handler = createMcpHandler(createServer);

export default {
  fetch(request, env, ctx) {
    return handler(request, env, ctx);
  }
} satisfies ExportedHandler;
```

The server is served at `/mcp` by default. `agents/mcp/server` uses `AsyncLocalStorage`, so enable `nodejs_compat`:

```jsonc
{
  "name": "hello-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-11",
  "compatibility_flags": ["nodejs_compat"]
}
```

`createMcpHandler` takes a factory, not a server instance, so concurrent requests never share one `McpServer`. Create the handler once at module scope and call it for each request.

Deploy the Worker and connect any MCP client to `https://<your-worker>.workers.dev/mcp`, or run `wrangler dev` and point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787/mcp`.

## Keep state in bindings

Nothing survives between requests inside the handler. Keep data in bindings and read them from your tools with `env` from `cloudflare:workers`:

```typescript
import { env } from "cloudflare:workers";

server.registerTool(
  "readFile",
  {
    description: "Read a file from the shared bucket",
    inputSchema: { path: z.string() }
  },
  async ({ path }) => {
    const object = await env.BUCKET.get(path);
    return {
      content: [
        { type: "text", text: object ? await object.text() : "Not found" }
      ]
    };
  }
);
```

For per-user state, call an Agent from the tool. The Agent owns the data, and the MCP server stays stateless:

```typescript
import { Agent, getAgentByName } from "agents";

export class Notes extends Agent<Env, { notes: string[] }> {
  initialState = { notes: [] };

  add(note: string) {
    this.setState({ notes: [...this.state.notes, note] });
    return this.state.notes.length;
  }
}

server.registerTool(
  "addNote",
  { inputSchema: { note: z.string() } },
  async ({ note }) => {
    const userId = String(getMcpAuthContext()?.props.userId ?? "anonymous");
    const notes = await getAgentByName(env.Notes, userId);
    const count = await notes.add(note);
    return { content: [{ type: "text", text: `You have ${count} notes` }] };
  }
);
```

Bind `Notes` as a Durable Object in `wrangler.jsonc` and export the class from your Worker. `getMcpAuthContext()` is covered in [Authentication](#authentication).

## Handler options

```typescript
createMcpHandler(() => createServer(), {
  route: "/mcp", // exact path to handle (default: "/mcp")
  corsOptions: {
    origin: "https://app.example.com"
  },
  allowedHostnames: ["mcp.example.com"], // custom-domain Host policy
  allowedOriginHostnames: ["app.example.com"], // browser Origin policy
  authContext: { props: {} }, // optional application props override
  legacy: "stateless", // default; use "reject" to serve only Stateless clients
  responseMode: "auto" // upstream SDK response shaping
});
```

`createMcpHandler` supports the upstream SDK v2 handler options except `bus`, which the Agents SDK does not expose. Supplying `bus` throws a `TypeError`.

### Origin and Host validation

The handler validates every present `Origin` header before serving the request. It rejects malformed, opaque, and non-HTTP origins. Requests without `Origin` remain valid for non-browser MCP clients.

Its default allowlist includes localhost-class origins and the endpoint's `workers.dev` hostname. A concrete `corsOptions.origin` adds that hostname automatically. The handler also applies matching Host checks to localhost and `workers.dev` endpoints. For a custom domain with wildcard CORS, configure `allowedHostnames` and `allowedOriginHostnames` explicitly. Values are hostnames without a scheme or port, and matching ignores the Origin's scheme and port.

Pass `allowedOriginHostnames: "*"` only when equivalent Origin validation runs in trusted middleware before the handler. This disables the handler's Origin check, including malformed and opaque Origin rejection. MCP HTTP servers are required to validate browser Origins, so do not use this as an unauthenticated public-server shortcut.

### Notify clients of changes

Use the returned handler's `notify` methods, such as `handler.notify.toolsChanged()`, to publish list and resource changes. Notifications are isolate-local: they do not reach subscriptions in other Worker isolates. See the [handler notification API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/#publish-list-and-resource-changes) for the available methods.

## Authentication

Wrap the handler with `OAuthProvider` from `@cloudflare/workers-oauth-provider` to require OAuth 2.1. The provider serves the authorization, token, and registration endpoints and validates Bearer tokens on `/mcp`:

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";

function createServer() {
  const server = new McpServer({ name: "Authenticated", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { description: "Returns the authenticated user" },
    async (context) => {
      const auth = getMcpAuthContext();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              userId: auth?.props.userId,
              clientId: context.http?.authInfo?.clientId,
              scopes: context.http?.authInfo?.scopes
            })
          }
        ]
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    }
  },
  defaultHandler: AuthHandler, // your consent and login flow
  // The URL MCP clients connect to. Every token is bound to it.
  resourceMetadata: { resource: env.MCP_RESOURCE }
});
```

`OAuthProvider` needs an object with a `fetch` method, so wrap the handler as shown. Passing the handler function directly throws at startup.

`getMcpAuthContext().props` returns the `props` you passed to `completeAuthorization()` in your auth flow. Tool callbacks also receive the standard SDK v2 `AuthInfo` at `context.http.authInfo`. `authInfo` is set only when the token has a client ID and `props` is a plain object. Tokens from `resolveExternalToken` have no client ID, so for those only `getMcpAuthContext().props` is available. Do not log or return `context.http.authInfo.token` or `authInfo.extra.props`.

Set `MCP_RESOURCE` in `wrangler.jsonc` to the URL clients connect to: Workers OAuth Provider 1.x binds every token to it. The OAuth flow also needs a KV namespace bound as `OAUTH_KV`. For a complete server with a login page, see [`examples/mcp-worker-authenticated`](https://github.com/cloudflare/agents/tree/main/examples/mcp-worker-authenticated). For the consent page and signing in through a third-party provider, see [Securing MCP Servers](./securing-mcp-servers.md).

## Elicitation

A tool can ask the user for input by returning `inputRequired(...)`. The client collects the input and retries the request with SDK-managed `requestState` and `inputResponses`. The Worker does not wait while a person responds.

```typescript
import {
  McpServer,
  acceptedContent,
  inputRequired
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Elicitation Demo",
    version: "1.0.0"
  });
  server.registerTool(
    "ask-name",
    { inputSchema: z.object({}) },
    async (_args, context) => {
      const answer = acceptedContent(
        context.mcpReq.inputResponses,
        "name",
        z.object({ name: z.string() })
      );
      if (!answer) {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "What is your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"]
              }
            })
          }
        });
      }
      return { content: [{ type: "text", text: `Hello ${answer.name}` }] };
    }
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer, { legacy: "reject" })(
      request,
      env,
      ctx
    );
  }
} satisfies ExportedHandler;
```

See [`examples/mcp-elicitation-mrtr`](https://github.com/cloudflare/agents/tree/main/examples/mcp-elicitation-mrtr) for a two-round example.

## 2025-era clients

With the default `legacy: "stateless"`, the same endpoint also answers 2025-era Streamable HTTP clients for tools, resources, and prompts. Those clients have no session to receive server-to-client requests, so sampling, pushed elicitation, and roots requests fail immediately. Set `legacy: "reject"` to serve only Stateless clients.

The handler does not serve the standalone SSE transport.

## Lower-level control

If the handler lifecycle does not fit, use the SDK's `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` directly in your Worker.

## Upgrading an existing `McpAgent` server

`McpAgent` is deprecated, but existing servers keep working. It is built on MCP SDK v1, which is an optional peer dependency of `agents`, so your package manager no longer installs it for you. Add the exact version your Agents release expects before you upgrade:

```sh
pnpm add agents @modelcontextprotocol/sdk@1.32.2 zod
```

Keep importing `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` in an `McpAgent`. An SDK v2 server from `@modelcontextprotocol/server` cannot run inside `McpAgent`. The same applies to `WorkerTransport` and `createLegacyMcpHandler` from `agents/mcp`.

`agents/x402` also needs `@modelcontextprotocol/sdk`. It does not load the package at runtime, but its types refer to SDK v1 clients and tools.

If your server imported `@modelcontextprotocol/sdk` without listing it in `package.json`, it only worked because `agents` installed the package. After you upgrade, the build fails with an unresolved `@modelcontextprotocol/sdk` import until you add it.

Client code does not need the v1 SDK. If you import client helpers such as `RPCClientTransport` or `normalizeServerId` from `agents/mcp`, import them from `agents/mcp/client` instead.

To move the server itself to `createMcpHandler`, follow [Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/).

## Examples

- [`examples/mcp-worker`](https://github.com/cloudflare/agents/tree/main/examples/mcp-worker): a minimal server with a browser tool tester
- [`examples/mcp-worker-authenticated`](https://github.com/cloudflare/agents/tree/main/examples/mcp-worker-authenticated): OAuth with `OAuthProvider`
- [`examples/mcp-elicitation-mrtr`](https://github.com/cloudflare/agents/tree/main/examples/mcp-elicitation-mrtr): Stateless Elicitation
