# Authenticated MCP Server Example

This example demonstrates using `createMcpHandler` to create an authenticated MCP server by wrapping it with [`OAuthProvider`](https://github.com/cloudflare/workers-oauth-provider) from `@cloudflare/workers-oauth-provider`.

This is the simplest way to deploy an authenticated MCP server on Cloudflare Workers.

## Setup

### 1. Create KV Namespace

```bash
wrangler kv:namespace create OAUTH_KV
```

### 2. Update wrangler.jsonc

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV",
      "id": "your-kv-namespace-id"
    }
  ]
}
```

### 3. Deploy

```bash
npm run deploy
```

## How It Works

1. **OAuth Provider** handles authentication endpoints
2. **API Handler** wraps your MCP server with `createMcpHandler`
3. **OAuth Provider** validates tokens and sets `ctx.props`
4. **MCP Tools** access user data via `getMcpAuthContext()`

```
Client → OAuth Flow → Token → MCP Request + Bearer Token → ctx.props → getMcpAuthContext()
```
