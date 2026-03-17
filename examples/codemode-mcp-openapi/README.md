# codemode-mcp-openapi

Demonstrates how to turn any OpenAPI spec into a pair of MCP tools (`search` + `execute`) using `openApiMcpServer`.

## What this shows

`openApiMcpServer` takes a raw OpenAPI spec and creates two tools:

- **`search`** — the LLM queries the spec as a JavaScript object to find endpoints, parameters, and schemas
- **`execute`** — the LLM calls the API via a host-side `request()` function you provide

Auth tokens and base URLs live in your `request()` function on the host. The sandbox that runs LLM-generated code has no outbound network access and never sees secrets.

This example connects to the live [Cloudflare API](https://api.cloudflare.com/) using the official OpenAPI spec. Pass a Cloudflare API token via the `Authorization` header.

## How to run

```bash
npm install
npm start
```

Then connect an MCP client with your Cloudflare API token:

```
Authorization: Bearer <your-cf-api-token>
```

The Worker reads the spec from GitHub on first request and caches it for the lifetime of the isolate.

## Key pattern

```ts
import { openApiMcpServer } from "@cloudflare/codemode/mcp";

const server = openApiMcpServer({
  spec,
  executor,
  request: async (opts) => {
    // Runs on the host — put auth, base URL, and headers here.
    // The sandbox never sees the token.
    const url = new URL(`https://api.example.com${opts.path}`);
    const res = await fetch(url, {
      method: opts.method,
      headers: { Authorization: `Bearer ${token}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    return res.json();
  }
});
```

The LLM first searches the spec:

```js
async () => {
  const spec = await codemode.spec();
  return Object.entries(spec.paths)
    .filter(([, item]) => item.get?.tags?.includes("zones"))
    .map(([path, item]) => ({ path, summary: item.get?.summary }));
};
```

Then executes calls:

```js
async () => {
  return await codemode.request({ method: "GET", path: "/zones" });
};
```

## Requirements

`wrangler.jsonc` needs a `worker_loaders` binding for the executor:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

## Related

- [codemode-mcp](../codemode-mcp/) — wrapping an existing MCP server instead of an OpenAPI spec
- [`@cloudflare/codemode` docs](../../packages/codemode/README.md)
