# Connectors

Connectors are class-based integrations that bridge external services into the codemode sandbox. Each connector extends `WorkerEntrypoint`, making it serializable, RPC-callable, and available as `ctx.exports.ConnectorName`.

**Why this exists:** there should be one way to add a capability. Whether the source is an MCP server, an OpenAPI spec, an AI SDK toolset, or your own service, the answer is the same — wrap it in a connector class, put it in a runtime, and the model sees it as a typed global (`github.list_pull_requests(...)`). The model-facing protocol never changes; only the class you subclass does.

Connectors define and execute tools. The [Runtime](./runtime.md) facet routes every call through a durable log — the connector owns definition and execution, while the runtime owns state, approvals, and rollback.

A connector answers three questions: what global name does the model use (`name`), what guidance does the model get (`instructions`), and what tools exist (`tools`). Each tool carries its own docs, schema, approval requirement, execution, and optional revert — **everything about a tool lives in one place**.

## Base class

```ts
import { CodemodeConnector } from "@cloudflare/codemode";

export class MyConnector extends CodemodeConnector<Env> {
  name() {
    return "myService";
  }

  protected instructions() {
    return "Use for interacting with My Service.";
  }

  protected tools() {
    return {
      listItems: {
        description: "List all items.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } }
        },
        execute: (args) => this.env.MY_SERVICE.list(args)
      },
      createItem: {
        description: "Create an item.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        },
        requiresApproval: true,
        execute: (args) => this.env.MY_SERVICE.create(args),
        revert: (_args, result) => this.env.MY_SERVICE.delete(result.id)
      }
    };
  }
}
```

### Authoring surface

| Method           | Required | Purpose                                                                          |
| ---------------- | -------- | -------------------------------------------------------------------------------- |
| `name()`         | Yes      | Unique namespace in the sandbox (`github`, `stripe`, etc.)                       |
| `instructions()` | No       | Guidance shown to the model                                                      |
| `tools()`        | Yes      | One record, one entry per tool (derived connectors generate it for you)          |
| `tool(name, t)`  | No       | Decoration hook — adjust tools you didn't author inline (approval, revert, docs) |

### Each tool

```ts
type ToolExecuteContext = { executionId: string };

type ConnectorTool = {
  description?: string;
  inputSchema?: JSONSchema7; // defaults to an open object
  outputSchema?: JSONSchema7;
  requiresApproval?: boolean; // omit to execute immediately
  execute: (
    args: unknown,
    ctx?: ToolExecuteContext
  ) => Promise<unknown> | unknown;
  revert?: (
    args: unknown,
    result: unknown,
    ctx?: ToolExecuteContext
  ) => Promise<void> | void;
};
```

`execute`/`revert` receive an optional `ctx` carrying the `executionId` of the run they belong to. The id is stable across a run's pause/resume passes, so it's the key to use for any resource scoped to the whole execution (see [Per-execution resources](#per-execution-resources)).

`requiresApproval: true` pauses the run for [approval](./approvals.md). `revert` enables [rollback](./runtime.md#rollback). Everything else executes immediately and is recorded in the durable log.

AI SDK tools are shape-compatible — an existing `ToolSet` can be returned from `tools()` directly:

```ts
export class LinearConnector extends CodemodeConnector<Env> {
  name() {
    return "linear";
  }
  protected tools() {
    return linearTools; // an AI SDK ToolSet
  }
}
```

### RPC surface (derived — you don't implement this)

The proxy tool talks to connectors over Workers RPC. The base class derives this wire surface from the tools record:

- `describe()` — name, instructions, descriptors, annotations
- `getTypeScriptTypes()` — TypeScript declarations for describe
- `executeTool(method, args, ctx?)` — dispatch to the tool's `execute`
- `revertAction(method, args, result, ctx?)` — dispatch to the tool's `revert`

## Per-execution resources

Some connectors own a resource that must live for the lifetime of one run — a browser/CDP session, a database transaction, a temp workspace. Two pieces of the contract make this work:

1. **`execute(args, ctx)`** receives the `executionId`. Use it to lazily acquire (or reconnect to) the resource on first use, keyed by that id. Because the id is stable across pause/resume, the resource is addressable even after a run pauses for approval and resumes in a later Worker invocation. `ctx` is typed optional (so AI SDK toolsets stay shape-compatible), so read it as `ctx?.executionId` — the runtime always provides it on a real call.
2. **`disposeExecution(executionId, status)`** is called when the run reaches a **terminal** state, so you can tear the resource down.

```ts
export class BrowserConnector extends CodemodeConnector<Env> {
  name() {
    return "browser";
  }

  protected tools() {
    return {
      navigate: {
        description: "Open a URL in the run's browser session.",
        execute: async ({ url }, ctx) => {
          const session = await this.sessionFor(ctx?.executionId);
          return session.goto(url);
        }
      }
    };
  }

  // Fires on completed / error / rejected / rolled_back — never on pause.
  override async disposeExecution(
    executionId: string,
    _status: ExecutionEndStatus
  ) {
    await this.closeSessionFor(executionId);
  }
}
```

`disposeExecution` is deliberately **not** called when a run pauses for approval — a paused run may resume, so a resource scoped to the whole run must survive the pause. It fires for **every** connector in the runtime on each terminal transition, not just the ones a run used, so a connector that opened nothing should find nothing to close. `status` is one of:

| `ExecutionEndStatus` | When                                      |
| -------------------- | ----------------------------------------- |
| `completed`          | the run finished and returned a result    |
| `error`              | the run threw or hit a replay divergence  |
| `rejected`           | a pending action was rejected by the user |
| `rolled_back`        | the run's applied effects were reverted   |

Implementation rules (the default is a no-op, so connectors with no per-run state skip it):

- **Idempotent.** It fires on each terminal transition, so it can run more than once for one execution — a `completed` run that is later rolled back disposes twice. The second call should no-op.
- **No instance memory.** It may run on a different connector instance than the one that opened the resource (the host can reconstruct connectors per request, and the opening pass may have hibernated). Read what you need from durable storage keyed by `executionId`.
- **Never throws.** Teardown failures must not turn a finished run into a failure; the runtime ignores rejections from this hook.

> To abandon a paused run and release its resources, [`reject`](./approvals.md) the pending action — that's a terminal transition and fires `disposeExecution`. (`rollback` only fires it when it actually reverts an effect; a paused, read-only run isn't terminated by rollback.)

> **AI SDK toolsets:** when `tools()` returns an AI SDK `ToolSet`, codemode passes `{ executionId }` as the tool's second `execute` argument — the slot the AI SDK uses for its own call options. Inside codemode those options aren't otherwise populated, but a tool authored against the AI SDK's `toolCallId`/`messages` won't receive them here.

## McpConnector

Wraps an MCP server. Each MCP tool becomes one entry in the tools record, executing through `connection.client.callTool()`. Tool names are sanitized into valid JS identifiers.

Implement `createConnection()`; decorate derived tools with the `tool(name, t)` hook:

```ts
import {
  McpConnector,
  type McpConnectionLike,
  type ConnectorTool
} from "@cloudflare/codemode";

export class GithubConnector extends McpConnector<Env> {
  constructor(
    ctx: ExecutionContext,
    env: Env,
    private conn: McpConnectionLike
  ) {
    super(ctx, env);
  }

  name() {
    return "github";
  }
  protected instructions() {
    return "Use for GitHub operations.";
  }
  protected createConnection() {
    return this.conn;
  }

  protected tool(name: string, t: ConnectorTool): ConnectorTool {
    if (name === "create_issue") {
      return {
        ...t,
        requiresApproval: true,
        revert: (_args, result) => this.closeIssue(result)
      };
    }
    return t;
  }
}
```

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

Wraps an OpenAPI spec. The base reads the spec **once, host-side** and derives one typed tool **per operation**, so the model calls operations directly — `stripe.CreatePaymentIntent({ amount, currency })` — discoverable through `codemode.search`/`describe` with real input types. Deriving on the host costs zero prompt tokens. Override two methods:

- `spec()` returns the OpenAPI document (used to derive operations).
- `request()` performs an authenticated request.

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
    return "Use for Stripe payments. Call the per-operation tools directly.";
  }
  protected spec() {
    return stripeOpenApiSpec;
  }

  protected request(options: OpenApiRequestOptions) {
    return fetch(`https://api.stripe.com${options.path}`, {
      method: options.method ?? "GET",
      headers: { Authorization: `Bearer ${this.env.STRIPE_KEY}` },
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then((r) => r.json());
  }
}
```

| Method             | Purpose                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `spec()`           | Required. Return the OpenAPI spec document. May be async. Operations are derived from it.       |
| `request(options)` | Required. Perform an authenticated request. Receives `{ path, method, params, body, headers }`. |
| `exposeSpec()`     | Optional. Return `true` to also expose the raw `spec` document as a tool. Off by default.       |

Each derived tool takes a single object: top-level keys are the operation's path/query/header parameters, plus a `body` key when the operation has a JSON request body. The base substitutes path params and hands `request()` a clean `{ path, method, params, body, headers }`. Local `$ref`s in the spec are inlined so the generated input types are usable. A low-level `request` tool is also exposed as an escape hatch for operations a derived tool can't reach.

Sandbox sees:

```ts
// Path params are substituted; the body is a typed object.
const intent = await stripe.CreatePaymentIntent({
  amount: 2000,
  currency: "usd"
});

// Escape hatch, if needed:
const raw = await stripe.request({
  path: "/v1/charges",
  method: "GET"
});
```

## File convention

Connector files use the `*.codemode.ts` extension. The codemode [Vite plugin](./vite-plugin.md) discovers them and auto-exports the classes from the worker entry module.

```
src/
  github.codemode.ts     → export class GithubConnector extends McpConnector
  stripe.codemode.ts     → export class StripeConnector extends OpenApiConnector
  linear.codemode.ts     → export class LinearConnector extends CodemodeConnector
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
    ctx: ExecutionContext,
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
  protected async request(options: OpenApiRequestOptions) {
    // Uses this.env.STRIPE_KEY
  }
}
```
