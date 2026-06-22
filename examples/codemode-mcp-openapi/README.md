# codemode-mcp-openapi

Demonstrates how to turn any OpenAPI spec into a pair of MCP tools (`search` + `execute`) using `openApiMcpServer`.

## What this shows

`openApiMcpServer` takes a raw OpenAPI spec and creates two tools:

- **`search`** — the LLM queries the spec as a JavaScript object to find endpoints, parameters, and schemas
- **`execute`** — the LLM calls the API via a host-side `request()` function you provide

Auth tokens and base URLs live in your `request()` function on the host. The sandbox has no outbound network access and never sees secrets. The callback's second argument is the MCP context for the outer `execute` tool call. Use it when an elicitation, sampling request, roots request, or notification belongs to that call.

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
  request: async (opts, context) => {
    // Runs on the host. Put auth, base URL, and headers here.
    // The sandbox sees neither the token nor the MCP context.
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

The second argument is the MCP SDK's request-scoped context. For example, a host callback can elicit confirmation through the same response stream as the outer tool call:

```ts
request: async (opts, context) => {
  const result = await server.server.elicitInput(
    {
      message: `Allow ${opts.method} ${opts.path}?`,
      requestedSchema: {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"]
      }
    },
    {
      relatedRequestId: context.requestId,
      signal: context.signal
    }
  );

  if (result.action !== "accept" || !result.content?.approved) {
    throw new Error("Request declined");
  }

  return callApi(opts);
};
```

The context stays in trusted host code and should only be used while the outer tool call is active. Existing callbacks that only accept `opts` continue to work.

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
