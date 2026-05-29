---
"@cloudflare/codemode": minor
---

Add connector model — class-based connectors extending WorkerEntrypoint for Gatekeeper-compatible tool integration.

**New classes:**

- `CodemodeConnector` — abstract base extending `WorkerEntrypoint` with template methods (`name()`, `instructions()`, `snippets()`, `annotations()`)
- `McpConnector` — MCP-backed connector with `createConnection()`, `toolName()`, `callTool()` lifecycle
- `OpenApiConnector` — OpenAPI spec connector with `spec()`, `request()` methods
- `ToolsetConnector` — wraps existing AI SDK toolsets

**Architecture:**

- Connectors are passed as env bindings to the sandbox — tool calls go via Workers RPC directly, no ToolDispatcher layer
- Platform SDK (`codemode.search`, `codemode.describe`, `codemode.connectors`) uses the provider/dispatcher path
- Model-facing proxy tool accepts `{ code }` — discovery lives inside the sandbox
- Executor-style ranked search with normalized tokenization and scoring

**Vite plugin** (`@cloudflare/codemode/vite`):

- Discovers `*.codemode.ts` files and auto-exports connector classes from the worker entry
- Makes connectors available as `ctx.exports.ConnectorName`
