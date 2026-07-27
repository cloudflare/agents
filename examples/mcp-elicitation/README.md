# Legacy Elicitation

> This example intentionally demonstrates the retained **Legacy / SDK v1** stateful path. For new Stateless servers, use the [`mcp-elicitation-mrtr`](../mcp-elicitation-mrtr/) **Stateless Elicitation** example.

The MCP endpoint is `/mcp` (for example, `http://localhost:8787/mcp` under `wrangler dev`). A Durable Object owns each MCP session, `WorkerTransport` persists its initialization state, and `DurableObjectEventStore` supports SSE reconnection.

Two tools demonstrate pushed 2025 `elicitation/create` requests:

- **`increase-counter`** — form-mode elicitation asks for an amount and updates Durable Object state.
- **`connect-account`** — URL-mode elicitation sends a sensitive link to the user out-of-band.

Pair it with the [`mcp-client`](../mcp-client/) example, which renders both elicitation modes in a browser UI.

## Run

```sh
pnpm install
pnpm run dev
```

## Why this example remains

Existing deployments may require session-addressed server-to-client requests, persistent initialization state, and SSE replay. Those behaviors are not provided by a stateless compatibility handler. The example therefore uses the explicit legacy APIs:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createLegacyMcpHandler,
  DurableObjectEventStore,
  WorkerTransport
} from "agents/mcp";
```
