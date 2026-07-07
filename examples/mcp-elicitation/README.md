# MCP Elicitation: modern MRTR and legacy sessions

This example serves two MCP generations on one `/mcp` endpoint:

- **MCP 2026-07-28** goes directly to a stateless SDK v2 `createMcpHandler`. Its `increase-counter` tool returns `inputRequired(...)`; a current client collects the amount and retries the tool with that response.
- **MCP 2025-era traffic** keeps the existing SDK v1 server, Durable Object session, persistent `WorkerTransport`, and push-style `elicitation/create` requests. It demonstrates both form-mode (`increase-counter`) and URL-mode (`connect-account`) elicitation.

The Worker calls `isLegacyRequest(request)` before any Durable Object lookup. Modern requests therefore do not create or wake `MyAgent`.

The [`mcp-client`](../mcp-client/) example remains a 2025-era client and renders both legacy elicitation modes in a browser UI. Client-side MRTR support is outside this example.

## Run

```sh
pnpm install
pnpm run dev
```

Connect a current MCP client to `http://localhost:8787/mcp` for the modern path, or pair the example with [`mcp-client`](../mcp-client/) for the legacy path.

## Key routing pattern

```ts
const modernHandler = createMcpHandler(createModernServer, {
  route: "/mcp",
  legacy: "reject"
});

export default {
  async fetch(request, env, ctx) {
    if (!(await isLegacyRequest(request))) {
      return modernHandler(request, env, ctx);
    }

    const sessionId =
      request.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const agent = await getAgentByName(bindings.MyAgent, sessionId);
    return agent.onMcpRequest(request);
  }
};
```
