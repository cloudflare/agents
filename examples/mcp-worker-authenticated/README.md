# Authenticated MCP Server

An MCP server protected by OAuth 2.1, using `@cloudflare/workers-oauth-provider`. Clients must complete the OAuth flow before calling tools — the auth context is then available inside tool handlers.

## What it demonstrates

- **OAuth 2.1 with MCP** — dynamic client registration, authorization code flow, and token exchange
- **`OAuthProvider`** — wrapping `createMcpHandler` with `@cloudflare/workers-oauth-provider`
- **`getMcpAuthContext()`** — accessing the authenticated user's identity inside tool handlers
- **Custom authorization UI** — a Hono-based approval page for the OAuth flow

## Running

First, create a KV namespace for OAuth state:

```sh
npx wrangler kv namespace create OAUTH_KV
```

Update the `kv_namespaces` binding in `wrangler.jsonc` with the returned ID, then:

```sh
npm install
npm run dev
```

Open the browser to see the server info page. To test the tools, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — it will handle the OAuth flow automatically.

## How it works

The `OAuthProvider` wraps the entire Worker. It intercepts OAuth endpoints (`/authorize`, `/oauth/token`, `/oauth/register`) and validates Bearer tokens on the API route (`/mcp`).

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";

const apiHandler = {
  async fetch(request, env, ctx) {
    const server = createServer();
    return createMcpHandler(server)(request, env, ctx);
  }
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: { fetch: (req, env, ctx) => AuthHandler.fetch(req, env, ctx) }
});
```

Inside tool handlers, access the authenticated user:

```typescript
server.registerTool("whoami", { description: "Who am I?" }, async () => {
  const auth = getMcpAuthContext();
  return {
    content: [{ type: "text", text: JSON.stringify(auth?.props) }]
  };
});
```

## Related examples

- [`mcp-worker`](../mcp-worker/) — same stateless pattern without authentication
- [`mcp-client`](../mcp-client/) — connecting to authenticated MCP servers as a client (handles OAuth automatically)
