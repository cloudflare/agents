# Authenticated MCP Server

An MCP server protected by OAuth 2.1, using `@cloudflare/workers-oauth-provider`. Clients must complete the OAuth flow before calling tools — the auth context is then available inside tool handlers.

## What it demonstrates

- **OAuth 2.1 with MCP** — dynamic client registration, authorization code flow, and token exchange
- **`OAuthProvider`** — wrapping `createMcpHandler` with `@cloudflare/workers-oauth-provider`
- **Standard MCP `AuthInfo`** — token metadata, client ID, scopes, expiry, resource, and `extra.props`
- **`getMcpAuthContext()`** — continued access to the existing application `props` shape
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

const apiHandler = createMcpHandler(createServer);

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: { fetch: (req, env, ctx) => AuthHandler.fetch(req, env, ctx) }
});
```

Inside tool handlers, access standard token metadata and the existing application props. Do not log or return the raw access token:

```typescript
server.registerTool("whoami", { description: "Who am I?" }, async (context) => {
  const auth = getMcpAuthContext();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          clientId: context.http?.authInfo?.clientId,
          scopes: context.http?.authInfo?.scopes,
          props: auth?.props
        })
      }
    ]
  };
});
```

The AuthInfo bridge is additive and version-independent: older `workers-oauth-provider` releases still provide `getMcpAuthContext()`, while a provider release containing the bridge automatically adds `context.http.authInfo` when both packages are upgraded.

## Related examples

- [`mcp-worker`](../mcp-worker/) — same stateless pattern without authentication
- [`mcp-client`](../mcp-client/) — connecting to authenticated MCP servers as a client (handles OAuth automatically)
