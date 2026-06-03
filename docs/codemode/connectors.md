# Connectors

Connectors are class-based integrations that bridge external services into the codemode sandbox. Each connector extends `WorkerEntrypoint`, making it serializable, RPC-callable, and available as `ctx.exports.ConnectorName`.

Connectors define the service and execute tools. The [Runtime](./runtime.md) facet routes every tool call through a durable log — the connector owns definition and execution, while the runtime owns state, approvals, and rollback.

## Base class

All connectors extend `CodemodeConnector`:

```ts
import { CodemodeConnector } from "@cloudflare/codemode";

export class MyConnector extends CodemodeConnector<Env> {
  name() {
    return "myService";
  }

  protected instructions() {
    return "Use for interacting with My Service.";
  }

  protected annotations() {
    return {
      listItems: { observation: true },
      createItem: { requiresApproval: true, approvalDescription: "Create item" }
    };
  }

  protected async loadDescriptors() {
    return {
      listItems: {
        description: "List all items.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } }
        }
      },
      createItem: {
        description: "Create an item.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        }
      }
    };
  }

  async executeTool(method: string, args: unknown) {
    if (method === "listItems") return this.env.MY_SERVICE.list(args);
    if (method === "createItem") return this.env.MY_SERVICE.create(args);
    throw new Error(`Unknown method: ${method}`);
  }
}
```

### Template methods

| Method                      | Required | Purpose                                                    |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `name()`                    | Yes      | Unique namespace in the sandbox (`github`, `stripe`, etc.) |
| `instructions()`            | No       | Human-readable instructions for the LLM                    |
| `annotations()`             | No       | Per-method permissions — observation, requiresApproval     |
| `loadDescriptors()`         | Yes      | JSON Schema descriptors for search/describe                |
| `executeTool(method, args)` | Yes      | Execute a tool method by name                              |
| `simulate(method, args)`    | No       | Return a provisional result for approval-pending actions   |

### RPC surface

The connector exposes these RPC methods (called by the proxy tool):

- `describe()` — returns connector docs (name, instructions, descriptors, annotations)
- `getTypeScriptTypes()` — returns TypeScript declarations for the LLM
- `getAnnotations()` — returns the annotation map
- `executeTool(method, args)` — called by the session facet to execute

## McpConnector

Wraps an MCP server. Each MCP tool becomes a method on the connector namespace.

Under the hood: fetches tools via `listTools()`, creates JSON Schema descriptors per tool, dispatches calls through `connection.client.callTool()`. Tool names are sanitized into valid JS identifiers.

```ts
import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";

export class GithubConnector extends McpConnector<Env> {
  #conn?: McpConnectionLike;
  setConnection(conn: McpConnectionLike) {
    this.#conn = conn;
  }

  name() {
    return "github";
  }
  protected instructions() {
    return "Use for GitHub operations.";
  }
  protected createConnection() {
    return this.#conn!;
  }

  protected annotations() {
    return {
      list_pull_requests: { observation: true },
      search_issues: { observation: true },
      create_issue: {
        requiresApproval: true,
        approvalDescription: "Create issue"
      }
    };
  }
}
```

### MCP-specific methods

| Method               | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `createConnection()` | Required. Return an MCP connection.                                  |
| `toolName(tool)`     | Override to customize how MCP tool names map to sandbox identifiers. |

Sandbox sees one method per MCP tool:

```ts
github.list_pull_requests({ owner, repo, state });
github.search_issues({ query });
```

## OpenApiConnector

Wraps an OpenAPI spec. Exposes **two methods** — `search` and `request` — rather than one method per endpoint. This keeps the tool surface small for large APIs.

Under the hood: `search` does substring matching across paths, methods, operationIds, and summaries. `request` delegates to the subclass's `request()` method.

```ts
import {
  OpenApiConnector,
  type OpenApiRequestOptions
} from "@cloudflare/codemode";

export class StripeConnector extends OpenApiConnector<Env> {
  name() {
    return "stripe";
  }
  protected instructions() {
    return "Use for Stripe payments.";
  }
  protected spec() {
    return stripeOpenApiSpec;
  }

  protected async request(input: OpenApiRequestOptions) {
    return fetch(`https://api.stripe.com/v1/...`, {
      headers: { Authorization: `Bearer ${this.env.STRIPE_KEY}` }
    }).then((r) => r.json());
  }
}
```

### OpenAPI-specific methods

| Method           | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `spec()`         | Required. Return the OpenAPI spec document. May be async.                     |
| `request(input)` | Required. Execute an API operation. Receives `{ operationId, params, body }`. |

Sandbox sees:

```ts
const ops = await stripe.search("payment intent");
const result = await stripe.request({
  operationId: "CreatePaymentIntent",
  params: { amount: 2000 }
});
```

## ToolsetConnector

Wraps an existing AI SDK `ToolSet` or codemode `ToolDescriptors`. Each tool becomes a method on the connector namespace.

```ts
import { ToolsetConnector } from "@cloudflare/codemode";

export class LinearConnector extends ToolsetConnector<Env> {
  name() {
    return "linear";
  }
  protected instructions() {
    return "Use for Linear issue tracking.";
  }
  protected tools() {
    return linearTools;
  }
}
```

### Toolset-specific methods

| Method    | Purpose                                      |
| --------- | -------------------------------------------- |
| `tools()` | Required. Return the tool set. May be async. |

Sandbox sees one method per tool:

```ts
linear.createIssue({ title, description });
linear.listIssues({ projectId });
```

## File convention

Connector files use the `*.codemode.ts` extension. The codemode vite plugin discovers them and auto-exports the classes from the worker entry module.

```
src/
  github.codemode.ts     → export class GithubConnector extends McpConnector
  stripe.codemode.ts     → export class StripeConnector extends OpenApiConnector
  linear.codemode.ts     → export class LinearConnector extends ToolsetConnector
  server.ts              → import with { type: "connectors" }
```

Import with the `type: "connectors"` attribute:

```ts
import { GithubConnector } from "./github.codemode" with { type: "connectors" };
```

## Constructor convention

Constructors are for **dependencies** — connections, tokens, clients. Service identity and behavior come from overridable methods, not constructor config.

```ts
// Good — constructor receives dependency
export class GithubConnector extends McpConnector<Env> {
  constructor(
    ctx: any,
    env: Env,
    private conn: McpConnectionLike
  ) {
    super(ctx, env);
  }
  name() {
    return "github";
  }
  protected createConnection() {
    return this.conn;
  }
}

// Also good — reads from env
export class StripeConnector extends OpenApiConnector<Env> {
  name() {
    return "stripe";
  }
  protected spec() {
    return stripeSpec;
  }
  protected async request(input) {
    // Uses this.env.STRIPE_KEY
  }
}
```
