# `@cloudflare/codemode`

Instead of asking LLMs to call tools directly, Code Mode lets them write executable code that orchestrates multiple operations. LLMs are better at writing code than calling tools — they've seen millions of lines of real-world code but only contrived tool-calling examples.

Code Mode generates TypeScript type definitions from your tools for LLM context, and executes the generated JavaScript in secure, isolated sandboxes with millisecond startup times.

The published package includes the Codemode guides at `docs/index.md`.

> **Experimental** — may have breaking changes. Use with caution in production.

## Installation

```sh
# With Vercel AI SDK
npm install @cloudflare/codemode agents ai zod

# With TanStack AI
npm install @cloudflare/codemode agents @tanstack/ai zod

# Utilities only (no framework peer deps needed)
npm install @cloudflare/codemode
```

The main entry point (`@cloudflare/codemode`) has **no peer dependency on `ai`, `@tanstack/ai`, or `zod`**. Framework-specific packages are only required when importing from `@cloudflare/codemode/ai` or `@cloudflare/codemode/tanstack-ai`.

## Quick Start

`createCodeTool` takes your tools and an executor, and returns a single AI SDK tool that lets the LLM write code instead of making individual tool calls.

```ts
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { streamText, tool } from "ai";
import { z } from "zod";

// 1. Define your tools using the AI SDK tool() wrapper
const tools = {
  getWeather: tool({
    description: "Get weather for a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => `Weather in ${location}: 72°F, sunny`
  }),
  sendEmail: tool({
    description: "Send an email",
    inputSchema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string()
    }),
    execute: async ({ to, subject, body }) => `Email sent to ${to}`
  })
};

// 2. Create an executor (runs code in an isolated Worker)
const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

// 3. Create the codemode tool
const codemode = createCodeTool({ tools, executor });

// 4. Use it with streamText — the LLM writes code that calls your tools
const result = streamText({
  model,
  system: "You are a helpful assistant.",
  messages,
  tools: { codemode }
});
```

The LLM sees a typed `codemode` object and writes code like:

```js
async () => {
  const weather = await codemode.getWeather({ location: "London" });
  if (weather.includes("sunny")) {
    await codemode.sendEmail({
      to: "team@example.com",
      subject: "Nice day!",
      body: `It's ${weather}`
    });
  }
  return { weather, notified: true };
};
```

## TanStack AI

If you're using TanStack AI instead of the Vercel AI SDK, import from `@cloudflare/codemode/tanstack-ai`:

```ts
import {
  createCodeTool,
  tanstackTools
} from "@cloudflare/codemode/tanstack-ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

// 1. Define your tools using TanStack AI's toolDefinition()
const getWeather = toolDefinition({
  name: "get_weather",
  description: "Get weather for a location",
  inputSchema: z.object({ location: z.string() })
}).server(async ({ location }) => `Weather in ${location}: 72°F, sunny`);

// 2. Create the codemode tool
const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const codeTool = createCodeTool({
  tools: [tanstackTools([getWeather])],
  executor
});

// 3. Use it with TanStack AI's chat()
const stream = chat({
  adapter: openaiText("gpt-4o"),
  tools: [codeTool],
  messages
});
```

`tanstackTools()` converts TanStack AI tools (array-based) into the record-based `ToolProvider` format. It also accepts an optional namespace:

```ts
createCodeTool({
  tools: [tanstackTools(weatherTools, "weather"), tanstackTools(dbTools, "db")],
  executor
});
```

## Tool Providers

Tool providers let you compose capabilities from different packages into a single sandbox execution. Each provider contributes tools under a namespace — the LLM can use all of them in the same code block.

```ts
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { stateTools } from "@cloudflare/shell/workers";

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

const codemode = createCodeTool({
  tools: [
    { tools: myTools }, // codemode.myTool({ query: "test" })
    stateTools(workspace) // state.readFile("/path")
  ],
  executor
});
```

The sandbox has both `codemode.*` and `state.*`:

```js
async () => {
  const files = await state.glob("/src/**/*.ts");
  const results = await Promise.all(
    files.map((f) => codemode.analyzeFile({ path: f }))
  );
  await state.writeJson("/report.json", results);
  return results.length;
};
```

### The `ToolProvider` interface

Any package can provide tools to the sandbox. A `ToolProvider` describes:

- an optional **name** (the namespace in the sandbox, e.g. `"state"`, `"db"` — defaults to `"codemode"`)
- **tools** — AI SDK tools, tool descriptors, or simple `{ execute }` records
- optional **types** for LLM context (auto-generated from tools if omitted)
- optional **positionalArgs** flag (e.g. `state.readFile("/path")` vs `codemode.search({ query })`)

```ts
import type { ToolProvider } from "@cloudflare/codemode";

const dbProvider: ToolProvider = {
  name: "db",
  tools: {
    query: {
      description: "Run a SQL query",
      execute: async (sql: unknown) => db.prepare(sql as string).all()
    }
  },
  positionalArgs: true
};
```

Pass providers as the `tools` array in `createCodeTool`, or resolve them for direct executor use:

```ts
import { resolveProvider } from "@cloudflare/codemode";

await executor.execute(code, [resolveProvider(dbProvider)]);
```

## Connectors

Connectors are class-based integrations that bridge external services into the codemode sandbox.

Create a runtime with an executor and connectors, then expose `runtime.tool()` to the model:

```ts
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor
} from "@cloudflare/codemode";

const runtime = createCodemodeRuntime({
  ctx: this.ctx,
  executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
  connectors: [github, repoApi]
});

const result = streamText({
  model,
  messages,
  tools: {
    codemode: runtime.tool()
  }
});
```

For non-AI-SDK hosts such as MCP servers, use the same runtime directly:

```ts
const matches = await runtime.search("create issue");
const docs = await runtime.describe(matches.results[0].path);
const outcome = await runtime.execute({
  code: `async () => github.create_issue({ title: "Bug" })`
});
```

Search and describe results include `requiresApproval: true` for protected connector methods. A paused `execute()` outcome can be resolved with the same `approve()` and `reject()` methods used by an approval UI.

Inside the sandbox, each connector is available as a global named after the connector. The `codemode` platform SDK provides discovery:

```ts
// discover
const matches = await codemode.search("pull request");
const docs = await codemode.describe("github.list_pull_requests");

// call
const prs = await github.list_pull_requests({
  owner: "cloudflare",
  repo: "agents"
});
```

### `McpConnector`

Wraps an MCP server. Each MCP tool becomes a method on the connector namespace.

Under the hood: fetches tools from the MCP connection via `listTools()`, creates a descriptor per tool for search/describe, and dispatches calls through `connection.client.callTool()`. Tool names are sanitized into valid JS identifiers.

```ts
// github.codemode.ts
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

  // Override to customize tool naming
  // protected toolName(tool: McpTool) { return sanitizeToolName(tool.name); }

  // Decorate derived tools: mark approvals, attach reverts
  protected tool(name: string, t: ConnectorTool): ConnectorTool {
    return name === "create_issue" ? { ...t, requiresApproval: true } : t;
  }
}
```

Sandbox sees:

```ts
github.list_pull_requests({ owner, repo, state });
github.search_issues({ query });
// ... one method per MCP tool
```

### `OpenApiConnector`

Wraps an OpenAPI spec. The base reads the spec **once, host-side** and derives one typed tool **per operation**, so the model calls operations directly — `stripe.CreatePaymentIntent({ amount, currency })` — discoverable through `codemode.search`/`describe` with real input types (deriving on the host costs zero prompt tokens). Override two methods: `spec()` returns the OpenAPI document (operations are derived from it), and `request()` performs an authenticated request. A low-level `request` tool stays available as an escape hatch.

```ts
// stripe.codemode.ts
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

Sandbox sees:

```ts
// Per-operation tool, derived from the spec (path params substituted for you).
const intent = await stripe.CreatePaymentIntent({
  amount: 2000,
  currency: "usd"
});

// Escape hatch, if an operation isn't reachable via a derived tool:
const raw = await stripe.request({ path: "/v1/charges", method: "GET" });
```

### `CodemodeConnector` (base class)

A connector is three things — `name()`, optional `instructions()`, and `tools()`. Each tool carries its own docs, schema, approval requirement, execution, and optional revert, so everything about a tool lives in one place:

```ts
import { CodemodeConnector } from "@cloudflare/codemode";

export class MyConnector extends CodemodeConnector<Env> {
  name() {
    return "myService";
  }

  protected tools() {
    return {
      listThings: {
        description: "List things.",
        inputSchema: { type: "object" },
        execute: (args) => this.env.MY_SERVICE.list(args)
      },
      createThing: {
        description: "Create a thing.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        },
        requiresApproval: true, // pauses the run for user approval
        execute: (args) => this.env.MY_SERVICE.create(args),
        revert: (_args, result) => this.env.MY_SERVICE.delete(result.id) // enables rollback
      }
    };
  }
}
```

An existing AI SDK `ToolSet` is shape-compatible and can be returned from `tools()` directly:

```ts
export class LinearConnector extends CodemodeConnector<Env> {
  name() {
    return "linear";
  }
  protected tools() {
    return linearTools; // AI SDK ToolSet
  }
}
```

The `tool(name, t)` decoration hook adjusts tools you didn't author inline (used with MCP/OpenAPI-derived tools). The RPC wire surface (`describe()`, `executeTool()`, `revertAction()`, `getTypeScriptTypes()`) is derived from the tools record — you don't implement it.

The agent drives approvals through the runtime: `runtime.pending()`, `runtime.approve({ executionId })`, `runtime.reject({ seq, executionId })`, `runtime.rollback({ executionId })` (see [docs/codemode/approvals.md](../../docs/codemode/approvals.md)).

### Snippets

Snippets are durable, addressable saved scripts. The model writes and runs scripts; the developer promotes the ones worth keeping (`runtime.saveSnippet`), and the model reuses them (`codemode.run`). No authoring step, no skill-source interface.

```ts
// host side: review runs, promote one
const runs = await runtime.executions();
await runtime.saveSnippet("list-open-prs", {
  executionId: runs[0].id,
  description: "List open PRs for a repo."
});

// sandbox side: the model runs it by name
const prs = await codemode.run("list-open-prs");
```

Snippets appear in `codemode.search` results (with `kind: "snippet"`) and are documented via `codemode.describe(name)`. They live on the runtime facet, whose identity is derived from the connector set — so a snippet is always run against exactly the connectors it was written with. See [docs/codemode/snippets.md](../../docs/codemode/snippets.md).

### Vite plugin

The `@cloudflare/codemode/vite` plugin exports the `CodemodeRuntime` facet class from the Worker entry module, making it available as `ctx.exports.CodemodeRuntime` for facet spawning:

```ts
// vite.config.ts
import codemode from "@cloudflare/codemode/vite";
export default { plugins: [codemode()] };
```

Connector classes are ordinary TypeScript imports:

```ts
import { GithubConnector } from "./github.codemode";
import { StripeConnector } from "./stripe.codemode";
```

### How connector calls work

```
┌─────────────────────┐        ┌─────────────────────────────────────────────┐
│                     │        │  Dynamic Worker (isolated sandbox)           │
│  Host Worker        │  RPC   │                                              │
│                     │◄──────►│  github.list_pull_requests(args)             │
│  Connectors are     │        │    → __connectors.github.callTool(...)       │
│  host-side RPC      │        │    → Workers RPC                             │
│  targets            │        │                                              │
│                     │        │  codemode.search("query")                    │
│  Platform SDK uses  │        │    → __dispatchers.codemode.call(...)        │
│  ToolDispatcher     │        │    → host-side search                        │
│                     │        │                                              │
└─────────────────────┘        └─────────────────────────────────────────────┘
```

Connector calls go via **Workers RPC** directly to the host-side connector binding — no JSON serialization through ToolDispatcher. The platform SDK (`codemode.search`, `codemode.describe`, etc.) uses the traditional ToolDispatcher path since it's host-created.

## Architecture

### How it works

```
┌─────────────────────┐        ┌─────────────────────────────────────────────┐
│                     │        │  Dynamic Worker (isolated sandbox)           │
│  Host Worker        │  RPC   │                                              │
│                     │◄──────►│  LLM-generated code runs here               │
│  ToolDispatchers    │        │  codemode.myTool() → dispatcher.call()       │
│  (one per namespace)│        │  state.readFile()  → dispatcher.call()       │
│                     │        │  db.query()        → dispatcher.call()       │
│                     │        │                                              │
│                     │        │  fetch() blocked by default                  │
└─────────────────────┘        └─────────────────────────────────────────────┘
```

1. `createCodeTool` generates TypeScript type definitions from your tool providers and builds a description the LLM can read
2. The LLM writes an async arrow function that calls `codemode.toolName(args)` and any provider namespaces (`state.*`, `db.*`, etc.)
3. Code is normalized via AST parsing (acorn) and sent to the executor
4. `DynamicWorkerExecutor` spins up an isolated Worker via `WorkerLoader`, with one `ToolDispatcher` per namespace
5. Inside the sandbox, a `Proxy` per namespace intercepts calls and routes them back via Workers RPC
6. Console output is captured and returned alongside the result

### Network isolation

External `fetch()` and `connect()` are **blocked by default** — enforced at the Workers runtime level via `globalOutbound: null`. Sandboxed code can only interact with the host through namespaced tool calls.

To allow controlled outbound access, pass a `Fetcher`:

```ts
const executor = new DynamicWorkerExecutor({
  loader: env.LOADER,
  globalOutbound: null // default — fully isolated
  // globalOutbound: env.MY_OUTBOUND_SERVICE, // route through a Fetcher
});
```

## The Executor Interface

The `Executor` interface is deliberately minimal — implement it to run code in any sandbox:

```ts
interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
}

interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}
```

`DynamicWorkerExecutor` is the Cloudflare Workers implementation, but you can build your own for Node VM, QuickJS, containers, or anything else.

```ts
// Example: a simple Node VM executor
class NodeVMExecutor implements Executor {
  async execute(code, fns): Promise<ExecuteResult> {
    try {
      const fn = new AsyncFunction("codemode", `return await (${code})()`);
      const result = await fn(fns);
      return { result };
    } catch (err) {
      return { result: undefined, error: err.message };
    }
  }
}
```

## Configuration

### Wrangler bindings

```jsonc
// wrangler.jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

### DynamicWorkerExecutor options

| Option           | Type                     | Default  | Description                                                  |
| ---------------- | ------------------------ | -------- | ------------------------------------------------------------ |
| `loader`         | `WorkerLoader`           | required | Worker Loader binding from `env.LOADER`                      |
| `timeout`        | `number`                 | `60000`  | Execution timeout in ms                                      |
| `globalOutbound` | `Fetcher \| null`        | `null`   | Network access control. `null` = blocked, `Fetcher` = routed |
| `modules`        | `Record<string, string>` | `{}`     | Extra modules importable in the sandbox                      |

### IframeSandboxExecutor options

Import from `@cloudflare/codemode/browser` when code should run in the browser
against browser-owned tools.

| Option    | Type     | Default                                                         | Description                                                              |
| --------- | -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `timeout` | `number` | `30000`                                                         | Execution timeout in ms. Cannot preempt tight synchronous browser loops. |
| `csp`     | `string` | `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';` | Content Security Policy applied to the sandbox iframe document.          |

### createCodeTool options

| Option        | Type                         | Default        | Description                                            |
| ------------- | ---------------------------- | -------------- | ------------------------------------------------------ |
| `tools`       | `ToolSet \| ToolDescriptors` | required       | Your tools (AI SDK `tool()` or raw descriptors)        |
| `executor`    | `Executor`                   | required       | Where to run the generated code                        |
| `description` | `string`                     | auto-generated | Custom tool description. Use `{{types}}` for type defs |

## Agent Integration

The user sends a message, the agent passes it to an LLM with the codemode tool, and the LLM writes and executes code to fulfill the request.

```ts
import { Agent } from "agents";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class MyAgent extends Agent<Env, State> {
  async onChatMessage() {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });

    const codemode = createCodeTool({ tools: myTools, executor });

    const result = streamText({
      model,
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(this.state.messages),
      tools: { codemode },
      stopWhen: stepCountIs(10)
    });

    // Stream response back to client...
  }
}
```

### With filesystem access (via `@cloudflare/shell`)

Combine `codemode.*` tools with `state.*` filesystem operations:

```ts
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";

export class MyAgent extends Agent<Env> {
  workspace = new Workspace({ sql: this.ctx.storage.sql });

  getCodemodeTool() {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return createCodeTool({
      tools: [{ tools: myDomainTools }, stateTools(this.workspace)],
      executor
    });
  }
}
```

### With MCP tools

MCP tools work the same way — just merge them into the tool set:

```ts
const codemode = createCodeTool({
  tools: {
    ...myTools,
    ...this.mcp.getAITools()
  },
  executor
});
```

## Utilities

### `sanitizeToolName(name)`

Converts tool names into valid JavaScript identifiers. Handles hyphens, dots, digits, reserved words. Called automatically by `DynamicWorkerExecutor` on `fns` keys — you only need this for custom use cases.

```ts
import { sanitizeToolName } from "@cloudflare/codemode";

sanitizeToolName("my-tool"); // "my_tool"
sanitizeToolName("3d-render"); // "_3d_render"
sanitizeToolName("delete"); // "delete_"
```

### `normalizeCode(code)`

Normalizes LLM-generated code into a valid async arrow function. Strips markdown code fences, handles various function formats. Called automatically by `DynamicWorkerExecutor` — you only need this for custom use cases.

````ts
import { normalizeCode } from "@cloudflare/codemode";

normalizeCode("```js\nconst x = 1;\nx\n```");
// "async () => {\nconst x = 1;\nreturn (x)\n}"
````

### `generateTypesFromJsonSchema(tools)`

Generates TypeScript type definitions from tool descriptors with plain JSON Schema. No AI SDK or Zod dependency required.

```ts
import { generateTypesFromJsonSchema } from "@cloudflare/codemode";

const types = generateTypesFromJsonSchema({
  getWeather: {
    description: "Get weather for a city",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" }
      },
      required: ["city"]
    }
  }
});
// Returns TypeScript declarations like:
// type GetWeatherInput = { city: string }
// declare const codemode: { getWeather: (input: GetWeatherInput) => Promise<...>; }
```

### `generateTypes(tools)` (AI SDK)

Generates TypeScript type definitions from AI SDK tools or Zod-based tool descriptors. Requires `ai` and `zod` peer dependencies.

```ts
import { generateTypes } from "@cloudflare/codemode/ai";

const types = generateTypes(myAiSdkTools);
```

## Module Structure

| Module                             | Peer deps             | Exports                                                                                                                              |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@cloudflare/codemode`             | None                  | `createCodemodeRuntime`, connector base classes, `DynamicWorkerExecutor`, executor utilities, JSON Schema type helpers               |
| `@cloudflare/codemode/ai`          | `ai`, `zod`           | `createCodeTool`, `generateTypes`, `aiTools`, `resolveProvider`, `ToolDescriptor`, `ToolDescriptors`                                 |
| `@cloudflare/codemode/tanstack-ai` | `@tanstack/ai`, `zod` | `createCodeTool`, `generateTypes`, `tanstackTools`, `resolveProvider`                                                                |
| `@cloudflare/codemode/browser`     | None                  | `createBrowserCodeTool`, `IframeSandboxExecutor`, `Executor`, `ExecuteResult`, `ResolvedProvider`, JSON Schema tool descriptor types |

## Limitations

- Runtime approval support applies to connector annotations. Legacy `createCodeTool` still excludes tools with `needsApproval: true` instead of pausing execution.
- Browser iframe execution uses nonce-scoped internal messages, but its timeout cannot preempt tight synchronous loops like `while (true) {}` because those block the browser event loop.
- Requires Cloudflare Workers environment for `DynamicWorkerExecutor`
- Limited to JavaScript execution

## Examples

- [`examples/codemode-connectors/`](../../examples/codemode-connectors/) — Runtime and connector example with MCP and OpenAPI connectors
- [`examples/codemode/`](../../examples/codemode/) — Full working example with task management tools
- [`examples/codemode-browser/`](../../examples/codemode-browser/) — Browser iframe executor example with dynamic client tools

## License

MIT
