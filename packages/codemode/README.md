# `@cloudflare/codemode`

Instead of asking LLMs to call tools directly, Code Mode lets them write executable code that orchestrates multiple operations. LLMs are better at writing code than calling tools — they've seen millions of lines of real-world code but only contrived tool-calling examples.

Code Mode generates TypeScript type definitions from your tools for LLM context, and executes the generated JavaScript in secure, isolated sandboxes with millisecond startup times.

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
| `timeout`        | `number`                 | `30000`  | Execution timeout in ms                                      |
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

| Module                             | Peer deps             | Exports                                                                                                                                                              |
| ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/codemode`             | None                  | `sanitizeToolName`, `normalizeCode`, `generateTypesFromJsonSchema`, `jsonSchemaToType`, `DynamicWorkerExecutor`, `ToolDispatcher`, `ToolProvider`, `resolveProvider` |
| `@cloudflare/codemode/ai`          | `ai`, `zod`           | `createCodeTool`, `generateTypes`, `aiTools`, `resolveProvider`, `ToolDescriptor`, `ToolDescriptors`                                                                 |
| `@cloudflare/codemode/tanstack-ai` | `@tanstack/ai`, `zod` | `createCodeTool`, `generateTypes`, `tanstackTools`, `resolveProvider`                                                                                                |
| `@cloudflare/codemode/browser`     | None                  | `createBrowserCodeTool`, `IframeSandboxExecutor`, `Executor`, `ExecuteResult`, `ResolvedProvider`, JSON Schema tool descriptor types                                 |

## Limitations

- **Tool approval (`needsApproval`) is not supported yet.** Tools with `needsApproval: true` or a `needsApproval` function are excluded from codemode instead of pausing execution for approval. Support for approval flows within codemode is planned. For now, use approval-required tools through standard AI SDK tool calling instead.
- Browser iframe execution uses nonce-scoped internal messages, but its timeout cannot preempt tight synchronous loops like `while (true) {}` because those block the browser event loop.
- Requires Cloudflare Workers environment for `DynamicWorkerExecutor`
- Limited to JavaScript execution

## Examples

- [`examples/codemode/`](../../examples/codemode/) — Full working example with task management tools
- [`examples/codemode-browser/`](../../examples/codemode-browser/) — Browser iframe executor example with dynamic client tools

## License

MIT
