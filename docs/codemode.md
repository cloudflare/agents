# Codemode (Experimental)

Codemode lets LLMs write and execute code that orchestrates your tools, instead of calling them one at a time. Inspired by [CodeAct](https://machinelearning.apple.com/research/codeact), it works because LLMs are better at writing code than making individual tool calls — they have seen millions of lines of real-world TypeScript but only contrived tool-calling examples.

The `@cloudflare/codemode` package converts your tools into typed TypeScript APIs, gives the LLM a single "write code" tool, and executes the generated code in a secure, isolated Worker sandbox.

> **Experimental** — this feature may have breaking changes in future releases. Use with caution in production.

## When to use Codemode

Codemode is most useful when the LLM needs to:

- **Chain multiple tool calls** with logic between them (conditionals, loops, error handling)
- **Compose results** from different tools before returning
- **Work with MCP servers** that expose many fine-grained operations
- **Perform multi-step workflows** that would require many round-trips with standard tool calling

For simple, single tool calls, standard AI SDK tool calling is simpler and sufficient.

## Installation

```sh
npm install @cloudflare/codemode ai zod
```

## Quick start

### 1. Define your tools

Use the standard AI SDK `tool()` function:

```typescript
import { tool } from "ai";
import { z } from "zod";

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
```

### 2. Create the codemode tool

`createCodeTool` takes your tools and an executor, and returns a single AI SDK tool:

```typescript
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";

const executor = new DynamicWorkerExecutor({
  loader: env.LOADER
});

const codemode = createCodeTool({ tools, executor });
```

### 3. Use it with streamText

Pass the codemode tool to `streamText` or `generateText` like any other tool. You choose the model:

```typescript
import { streamText } from "ai";

const result = streamText({
  model,
  system: "You are a helpful assistant.",
  messages,
  tools: { codemode }
});
```

When the LLM decides to use codemode, it writes an async arrow function like:

```javascript
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

The code runs in an isolated Worker sandbox, tool calls are dispatched back to the host via Workers RPC, and the result is returned to the LLM.

## Configuration

### Wrangler bindings

Add a `worker_loaders` binding to your `wrangler.jsonc`. This is the only binding required:

```jsonc
// wrangler.jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

### Vite configuration

If you use `zod-to-ts` (which codemode depends on), add a `__filename` define to your Vite config:

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react(), cloudflare(), tailwindcss()],
  define: {
    __filename: "'index.ts'"
  }
});
```

## How it works

```
┌─────────────┐        ┌──────────────────────────────────────┐
│             │        │  Dynamic Worker (isolated sandbox)   │
│  Host       │  RPC   │                                      │
│  Worker     │◄──────►│  LLM-generated code runs here        │
│             │        │  codemode.myTool() → dispatcher.call()│
│  ToolDispatcher      │                                      │
│  holds tool fns      │  fetch() blocked by default          │
└─────────────┘        └──────────────────────────────────────┘
```

1. `createCodeTool` generates TypeScript type definitions from your tools and builds a description the LLM can read
2. The LLM writes an async arrow function that calls `codemode.toolName(args)`
3. The code is normalized via AST parsing (acorn) and sent to the executor
4. `DynamicWorkerExecutor` spins up an isolated Worker via `WorkerLoader`
5. Inside the sandbox, a `Proxy` intercepts `codemode.*` calls and routes them back to the host via Workers RPC (`ToolDispatcher extends RpcTarget`)
6. Console output (`console.log`, `console.warn`, `console.error`) is captured and returned in the result

### Network isolation

External `fetch()` and `connect()` are **blocked by default** — enforced at the Workers runtime level via `globalOutbound: null`. Sandboxed code can only interact with the host through `codemode.*` tool calls.

To allow controlled outbound access, pass a `Fetcher`:

```typescript
const executor = new DynamicWorkerExecutor({
  loader: env.LOADER,
  globalOutbound: null // default — fully isolated
  // globalOutbound: env.MY_OUTBOUND_SERVICE  // route through a Fetcher
});
```

## Using with an Agent

The typical pattern is to create the executor and codemode tool inside an Agent's message handler:

```typescript
import { Agent } from "agents";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class MyAgent extends Agent<Env, State> {
  async onChatMessage() {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({
      tools: myTools,
      executor
    });

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

### With MCP tools

MCP tools work the same way — merge them into the tool set:

```typescript
const codemode = createCodeTool({
  tools: {
    ...myTools,
    ...this.mcp.getAITools()
  },
  executor
});
```

Tool names with hyphens or dots (common in MCP) are automatically sanitized to valid JavaScript identifiers (e.g., `my-server.list-items` becomes `my_server_list_items`).

## The Executor interface

The `Executor` interface is deliberately minimal — implement it to run code in any sandbox:

```typescript
interface Executor {
  execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}

interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}
```

`DynamicWorkerExecutor` is the built-in Cloudflare Workers implementation. You can build your own for Node VM, QuickJS, containers, or any other sandbox.

## API reference

### `createCodeTool(options)`

Returns an AI SDK compatible `Tool`.

| Option        | Type                         | Default        | Description                                            |
| ------------- | ---------------------------- | -------------- | ------------------------------------------------------ |
| `tools`       | `ToolSet \| ToolDescriptors` | required       | Your tools (AI SDK `tool()` or raw descriptors)        |
| `executor`    | `Executor`                   | required       | Where to run the generated code                        |
| `description` | `string`                     | auto-generated | Custom tool description. Use `{{types}}` for type defs |

### `DynamicWorkerExecutor`

Executes code in an isolated Cloudflare Worker via `WorkerLoader`.

| Option           | Type              | Default  | Description                                                  |
| ---------------- | ----------------- | -------- | ------------------------------------------------------------ |
| `loader`         | `WorkerLoader`    | required | Worker Loader binding from `env.LOADER`                      |
| `timeout`        | `number`          | `30000`  | Execution timeout in ms                                      |
| `globalOutbound` | `Fetcher \| null` | `null`   | Network access control. `null` = blocked, `Fetcher` = routed |

### `generateTypes(tools)`

Generates TypeScript type definitions from your tools. Used internally by `createCodeTool` but exported for custom use (e.g., displaying types in a frontend).

```typescript
import { generateTypes } from "@cloudflare/codemode";

const types = generateTypes(myTools);
// Returns:
// type CreateProjectInput = { name: string; description?: string }
// declare const codemode: { createProject: (input: CreateProjectInput) => Promise<unknown>; }
```

### `sanitizeToolName(name)`

Converts tool names into valid JavaScript identifiers.

```typescript
import { sanitizeToolName } from "@cloudflare/codemode";

sanitizeToolName("get-weather"); // "get_weather"
sanitizeToolName("3d-render"); // "_3d_render"
sanitizeToolName("delete"); // "delete_"
```

## Security considerations

- Code runs in **isolated Worker sandboxes** — each execution gets its own Worker instance
- External network access (`fetch`, `connect`) is **blocked by default** at the runtime level
- Tool calls are dispatched via Workers RPC, not network requests
- Execution has a configurable **timeout** (default 30 seconds)
- Console output is captured separately and does not leak to the host

## Current limitations

- **Tool approval (`needsApproval`) is not supported yet.** Tools with `needsApproval: true` execute immediately inside the sandbox without pausing for approval. Support for approval flows within codemode is planned. For now, do not pass approval-required tools to `createCodeTool` — use them through standard AI SDK tool calling instead.
- Requires Cloudflare Workers environment for `DynamicWorkerExecutor`
- Limited to JavaScript execution
- The `zod-to-ts` dependency bundles the TypeScript compiler, which increases Worker size
- LLM code quality depends on prompt engineering and model capability

## Example

See [`examples/codemode/`](../examples/codemode/) for a full working example — a project management assistant that uses codemode to orchestrate tasks, sprints, and comments via SQLite.
