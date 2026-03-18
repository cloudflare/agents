# `@cloudflare/codemode`

Instead of asking LLMs to call tools directly, Code Mode lets them write executable code that orchestrates multiple operations. LLMs are better at writing code than calling tools — they've seen millions of lines of real-world code but only contrived tool-calling examples.

Code Mode generates TypeScript type definitions from your tools for LLM context, and executes the generated JavaScript in secure, isolated sandboxes with millisecond startup times.

> **Experimental** — may have breaking changes. Use with caution in production.

## Installation

```sh
# Full AI SDK integration
npm install @cloudflare/codemode agents ai zod

# Utilities only (no ai/zod peer deps needed)
npm install @cloudflare/codemode
```

The main entry point (`@cloudflare/codemode`) has **no peer dependency on `ai` or `zod`**. The `ai` and `zod` packages are only required when importing from `@cloudflare/codemode/ai`.

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

## Plugins

Plugins add named globals to the sandbox alongside `codemode.*`. They let you compose capabilities from different packages into a single execution — the LLM can use all of them in the same code block.

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { statePlugin } from "@cloudflare/shell/workers";

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

const result = await executor.execute(code, tools, [
  statePlugin(backend) // adds state.* for filesystem operations
  // future: kvPlugin(env.KV), dbPlugin(d1), ...
]);
```

The sandbox now has both `codemode.*` tool calls and `state.*` (or any other plugin global):

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

### The `SandboxPlugin` interface

Any package can provide a plugin. A plugin is just an object describing:

- a **name** (the global variable in the sandbox, e.g. `"state"`)
- a host-side **dispatcher** (`RpcTarget`) that handles calls from the sandbox
- an optional **module** to inject into the sandbox
- a **`createGlobal`** function that generates the setup code for the named global
- optional **`types`** for use in LLM system prompts

```ts
import type { SandboxPlugin } from "@cloudflare/codemode";

const myPlugin: SandboxPlugin = {
  name: "db",
  dispatcher: new MyDbDispatcher(db),
  createGlobal: (ref) => ({
    init: `const db = createDbClient(${ref});`
  }),
  types: "declare const db: { query(sql: string): Promise<unknown[]>; };"
};
```

Pass plugins to any `executor.execute()` call:

```ts
await executor.execute(code, tools, [myPlugin]);
```

## Architecture

### How it works

```
┌─────────────────────┐        ┌─────────────────────────────────────────────┐
│                     │        │  Dynamic Worker (isolated sandbox)           │
│  Host Worker        │  RPC   │                                              │
│                     │◄──────►│  LLM-generated code runs here               │
│  ToolDispatcher     │        │  codemode.myTool() → dispatcher.call()       │
│  (tool fns)         │        │  state.readFile()  → stateDispatcher.call()  │
│                     │        │  db.query()        → dbDispatcher.call()     │
│  plugin dispatchers │        │                                              │
│  (RpcTargets)       │        │  fetch() blocked by default                  │
└─────────────────────┘        └─────────────────────────────────────────────┘
```

1. `createCodeTool` generates TypeScript type definitions from your tools and builds a description the LLM can read
2. The LLM writes an async arrow function that calls `codemode.toolName(args)` and any plugin globals
3. Code is normalized via AST parsing (acorn) and sent to the executor
4. `DynamicWorkerExecutor` spins up an isolated Worker via `WorkerLoader`
5. Inside the sandbox, a `Proxy` intercepts `codemode.*` calls and routes them back via Workers RPC (`ToolDispatcher extends RpcTarget`). Each plugin's dispatcher is passed separately and powers its named global.
6. Console output is captured and returned alongside the result

### Network isolation

External `fetch()` and `connect()` are **blocked by default** — enforced at the Workers runtime level via `globalOutbound: null`. Sandboxed code can only interact with the host through `codemode.*` tool calls and plugin globals.

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
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    plugins?: SandboxPlugin[]
  ): Promise<ExecuteResult>;
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
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { Workspace, createWorkspaceStateBackend } from "@cloudflare/shell";
import { statePlugin } from "@cloudflare/shell/workers";

export class MyAgent extends Agent<Env> {
  workspace = new Workspace(this);

  async runCode(code: string, tools: ToolSet) {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const backend = createWorkspaceStateBackend(this.workspace);
    return executor.execute(code, tools, [statePlugin(backend)]);
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

| Module                    | Requires `ai`/`zod` | Exports                                                                                                                                            |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/codemode`    | No                  | `sanitizeToolName`, `normalizeCode`, `generateTypesFromJsonSchema`, `jsonSchemaToType`, `DynamicWorkerExecutor`, `ToolDispatcher`, `SandboxPlugin` |
| `@cloudflare/codemode/ai` | Yes                 | `createCodeTool`, `generateTypes`, `ToolDescriptor`, `ToolDescriptors`                                                                             |

## Limitations

- **Tool approval (`needsApproval`) is not supported yet.** Tools with `needsApproval: true` execute immediately inside the sandbox without pausing for approval. Support for approval flows within codemode is planned. For now, do not pass approval-required tools to `createCodeTool` — use them through standard AI SDK tool calling instead.
- Requires Cloudflare Workers environment for `DynamicWorkerExecutor`
- Limited to JavaScript execution

## Examples

- [`examples/codemode/`](../../examples/codemode/) — Full working example with task management tools

## License

MIT
