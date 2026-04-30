# @cloudflare/think

An opinionated chat agent base class for Cloudflare Workers. Handles the full chat lifecycle — agentic loop, streaming, persistence, client tools, stream resumption — all backed by Durable Object SQLite.

Works as both a **top-level agent** (WebSocket chat protocol for browser clients) and a **sub-agent** (RPC streaming from a parent agent).

> **Experimental** — the API surface is stable but may evolve before graduating out of experimental.

## Quick start

```ts
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt() {
    return "You are a helpful coding assistant.";
  }
}
```

That's it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, client tool support, and workspace file tools. Connect from the browser with `useAgentChat` from `@cloudflare/ai-chat`.

## Agent tools

Think subclasses can be dispatched as agent tools from another Agent. The parent
uses `runAgentTool()` or `agentTool()` from `agents/agent-tools`; the child Think
instance owns its own messages, resumable stream, tools, and storage.

```ts
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";

export class Researcher extends Think<Env> {
  getSystemPrompt() {
    return "Research the requested topic and end with a concise summary.";
  }
}

export class Assistant extends Think<Env> {
  getTools() {
    return {
      research: agentTool(Researcher, {
        description: "Research one topic in depth.",
        inputSchema: z.object({ query: z.string().min(3) }),
        displayName: "Researcher"
      })
    };
  }
}
```

The parent broadcasts `agent-tool-event` frames for live UI rendering and keeps
the child facet until `clearAgentToolRuns()` deletes retained runs.

See the full [Agent Tools guide](../../docs/agent-tools.md) for rendering,
drill-in, and cleanup patterns.

## Built-in workspace

Every Think agent gets `this.workspace` — a virtual filesystem backed by the DO's SQLite storage. Workspace tools (`read`, `write`, `edit`, `list`, `find`, `grep`, `delete`) are automatically available to the model.

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }
  // this.workspace is ready to use — no setup needed
  // workspace tools are auto-merged into every chat turn
}
```

Override to add R2 spillover for large files:

```ts
export class MyAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });
}
```

## Exports

| Export                               | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| `@cloudflare/think`                  | `Think`, `Session`, `Workspace` — main class + re-exports     |
| `@cloudflare/think/tools/workspace`  | `createWorkspaceTools()` — for custom storage backends        |
| `@cloudflare/think/tools/execute`    | `createExecuteTool()` — sandboxed code execution via codemode |
| `@cloudflare/think/tools/extensions` | `createExtensionTools()` — LLM-driven extension loading       |
| `@cloudflare/think/extensions`       | `ExtensionManager`, `HostBridgeLoopback` — extension runtime  |

## Think

### Configuration

| Method / Property    | Default                          | Description                                     |
| -------------------- | -------------------------------- | ----------------------------------------------- |
| `getModel()`         | throws                           | Return the `LanguageModel` to use               |
| `getSystemPrompt()`  | `"You are a helpful assistant."` | System prompt (fallback when no context blocks) |
| `getTools()`         | `{}`                             | AI SDK `ToolSet` for the agentic loop           |
| `maxSteps`           | `10`                             | Max tool-call rounds per turn (property)        |
| `configureSession()` | identity                         | Add context blocks, compaction, search, skills  |
| `getExtensions()`    | `[]`                             | Sandboxed extension declarations (load order)   |
| `extensionLoader`    | `undefined`                      | `WorkerLoader` binding — enables extensions     |

### Lifecycle hooks

Think owns the `streamText` call. Hooks fire on every turn regardless of entry path (WebSocket, `chat()`, `saveMessages`, auto-continuation).

| Hook                     | When it fires                               | Return                         |
| ------------------------ | ------------------------------------------- | ------------------------------ |
| `beforeTurn(ctx)`        | Before `streamText` — see assembled context | `TurnConfig` overrides or void |
| `beforeStep(ctx)`        | Before each model step                      | `StepConfig` overrides or void |
| `beforeToolCall(ctx)`    | Before tool's `execute` runs                | `ToolCallDecision` or void     |
| `afterToolCall(ctx)`     | After tool execution (success or failure)   | void                           |
| `onStepFinish(ctx)`      | After each step completes                   | void                           |
| `onChunk(ctx)`           | Per streaming chunk (high-frequency)        | void                           |
| `onChatResponse(result)` | After turn completes + message persisted    | void                           |
| `onChatError(error)`     | On error during a turn                      | error to propagate             |

The AI SDK-derived contexts spread the SDK's own types at the top level — no information is dropped:

| Context                        | Backed by                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PrepareStepContext<TOOLS>`    | `Parameters<PrepareStepFunction<TOOLS>>[0]` (`steps`, `stepNumber`, `model`, `messages`, `experimental_context`)                      |
| `ToolCallContext<TOOLS>`       | `TypedToolCall<TOOLS>` + per-call extras from `OnToolCallStartEvent` (`stepNumber`, `messages`, `abortSignal`)                        |
| `ToolCallResultContext<TOOLS>` | `TypedToolCall<TOOLS>` + per-call extras (`durationMs`, `messages`, `stepNumber`) + discriminated `success`/`output`/`error` outcome  |
| `StepContext<TOOLS>`           | `StepResult<TOOLS>` (full step incl. `reasoning`, `sources`, `files`, `usage`, `providerMetadata`, `request`, `response`, `warnings`) |
| `ChunkContext<TOOLS>`          | `Parameters<StreamTextOnChunkCallback<TOOLS>>[0]` (discriminated `TextStreamPart`)                                                    |

`beforeStep` is wired to the AI SDK's `prepareStep` callback. Return a `StepConfig` to override `model`, `toolChoice`, `activeTools`, `system`, `messages`, `experimental_context`, or `providerOptions` for the current step. The AI SDK does not expose `output` or `maxSteps` per step — set those at the turn level via `TurnConfig` (returned from `beforeTurn`). `beforeStep` is subclass-only; it is not dispatched to extensions because the prepareStep event surface includes a live `LanguageModel` instance which is not JSON-safe to snapshot.

`TurnConfig` also accepts an `output` field that is forwarded to `streamText` as the AI SDK's structured-output spec. Combine with `activeTools: []` for providers (e.g. `workers-ai-provider`) that strip tools when `responseFormat: "json"` is active.

Per-tool hooks are wired so `beforeToolCall` fires _before_ `execute` (Think wraps every tool's `execute`) and `afterToolCall` fires _after_ (via the AI SDK's `experimental_onToolCallFinish`) with `durationMs` and a discriminated outcome. `beforeToolCall` can return a `ToolCallDecision` to:

- `{ action: "allow", input? }` — run the original `execute`, optionally with a substituted `input`.
- `{ action: "block", reason? }` — skip `execute`; the model sees `reason` as the tool's output.
- `{ action: "substitute", output }` — skip `execute`; the model sees `output` as the tool's output.

Pass an explicit `TOOLS` generic when you want full input typing:

```ts
import type {
  PrepareStepContext,
  StepContext,
  ToolCallContext,
  ToolCallResultContext
} from "@cloudflare/think";

const tools = { search: tool({ inputSchema: z.object({ query: z.string() }), ... }) };

beforeStep(ctx: PrepareStepContext<typeof tools>) {
  if (ctx.stepNumber === 0) {
    return {
      activeTools: ["search"],
      toolChoice: { type: "tool", toolName: "search" }
    };
  }
}

beforeToolCall(ctx: ToolCallContext<typeof tools>) {
  if (ctx.toolName === "search") {
    ctx.input.query; // typed as string
    // Clamp the model's `limit` before the tool runs.
    return {
      action: "allow",
      input: { ...ctx.input, limit: Math.min(ctx.input.limit ?? 10, 50) }
    };
  }
}

afterToolCall(ctx: ToolCallResultContext<typeof tools>) {
  if (ctx.success) {
    console.log(`${ctx.toolName} ok in ${ctx.durationMs}ms`, ctx.output);
  } else {
    console.error(`${ctx.toolName} failed:`, ctx.error);
  }
}

onStepFinish(ctx: StepContext<typeof tools>) {
  // Provider-specific cache accounting (Anthropic example)
  const anthropic = ctx.providerMetadata?.anthropic as
    | { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
    | undefined;
  console.log("cache read:", anthropic?.cacheReadInputTokens ?? 0);
}
```

> Field rename note: the per-tool contexts use the AI SDK's `input`/`output` (formerly `args`/`result` in earlier Think versions). Migrate by renaming references in your hooks. `afterToolCall` is now a discriminated union — read `output` only when `ctx.success === true`.

### Extension hook subscriptions

Extensions can subscribe to `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, and `onChunk` via their manifest's `hooks` array. Think dispatches to extension-side handlers in load order with a JSON-safe snapshot of the event. `beforeStep` is available to subclasses only and is not dispatched to extensions.

```js
// extension source (loaded via getExtensions())
({
  tools: {
    /* ... */
  },
  hooks: {
    beforeToolCall: async (snapshot, host) => {
      /* observation */
    },
    afterToolCall: async (snapshot, host) => {
      await host?.writeFile(
        `logs/${snapshot.toolName}.json`,
        JSON.stringify(snapshot)
      );
    },
    onStepFinish: async (snapshot, host) => {
      /* observation */
    }
    // onChunk is also supported but fires per token — use sparingly.
  }
});
```

The handler signature is `(snapshot, host) => void`, symmetric with tool `execute`. Errors from extension hooks are caught and logged; they do not abort the turn. Only `beforeTurn` honors return values — the other extension hooks are observation-only. See [docs/think/lifecycle-hooks.md](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md#extension-hook-subscriptions) for the full snapshot shapes.

#### beforeTurn example

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }

  // Switch to a cheaper model for continuation turns
  beforeTurn(ctx: TurnContext) {
    if (ctx.continuation) {
      return { model: this.cheapModel };
    }
  }
}
```

#### TurnConfig — what you can override per-turn

```ts
interface TurnConfig {
  model?: LanguageModel; // override model
  system?: string; // override system prompt
  messages?: ModelMessage[]; // override assembled messages
  tools?: ToolSet; // extra tools to merge (additive)
  activeTools?: string[]; // limit which tools the model can call
  toolChoice?: ToolChoice; // force a specific tool
  maxSteps?: number; // override maxSteps for this turn
  providerOptions?: Record<string, unknown>;
}
```

### Client tools

Think supports client-defined tools that execute in the browser. The client sends tool schemas in the chat request body, and Think merges them with server tools automatically.

When the LLM calls a client tool, the tool call chunk is sent to the client. The client executes it and sends back `CF_AGENT_TOOL_RESULT`. Think applies the result, persists the updated message, broadcasts `CF_AGENT_MESSAGE_UPDATED`, and optionally auto-continues the conversation.

Tool approval flows are also supported via `CF_AGENT_TOOL_APPROVAL`.

### Session and context blocks

Think uses Session for conversation storage. Override `configureSession` to add persistent memory, skills, compaction, and search:

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }

  configureSession(session: Session) {
    return session
      .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
      .withCachedPrompt();
  }
}
```

#### Dynamic context blocks

Context blocks can also be added at runtime (e.g., by extensions):

```ts
await session.addContext("notes", { description: "User notes" });
await session.refreshSystemPrompt(); // rebuild the prompt

session.removeContext("notes");
await session.refreshSystemPrompt();
```

#### Skills

Skills support load/unload for explicit context management:

```ts
import { R2SkillProvider } from "agents/experimental/memory/session";

configureSession(session: Session) {
  return session
    .withContext("skills", {
      provider: new R2SkillProvider(this.env.SKILLS_BUCKET, { prefix: "skills/" })
    })
    .withCachedPrompt();
}
// Model gets load_context and unload_context tools automatically
```

### MCP integration

Think inherits MCP client support from the Agent base class. MCP tools are automatically merged into every turn. Set `waitForMcpConnections` to ensure MCP servers are connected before the inference loop runs:

```ts
export class MyAgent extends Think<Env> {
  waitForMcpConnections = true; // or { timeout: 10_000 }
}
```

### Sub-agent streaming via RPC

When used as a sub-agent (via `this.subAgent()`), the `chat()` method runs a full turn and streams events via a callback:

```ts
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}

const agent = await this.subAgent(MyAgent, "thread-1");
await agent.chat("Summarize the project", relay, {
  tools: extraTools,
  signal: abortController.signal
});
```

### Dynamic configuration

`configure()` and `getConfig()` persist a JSON-serializable config blob in SQLite — useful for private server-side settings that should survive hibernation and restarts. Pass the config shape as a method generic for typed call sites:

```ts
type MyConfig = { modelTier: "fast" | "capable"; systemPrompt: string };

export class MyAgent extends Think<Env> {
  getModel() {
    const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }
}
```

For values you want broadcast to connected clients, use `state` / `setState` from `Agent` instead.

### Production features

- **WebSocket protocol** — wire-compatible with `useAgentChat` from `@cloudflare/ai-chat`
- **Built-in workspace** — every agent gets `this.workspace` with file tools auto-wired
- **Lifecycle hooks** — `beforeTurn`, `beforeStep`, `onStepFinish`, `onChunk`, `onChatResponse` fire on every turn
- **Stream resumption** — page refresh replays buffered chunks via `ResumableStream`
- **Client tools** — accept tool schemas from clients, handle results and approvals
- **Auto-continuation** — debounce-based continuation after tool results
- **MCP integration** — MCP tools auto-merged, wait for connections before inference
- **Abort/cancel** — pass an `AbortSignal` or send a cancel message
- **Multi-tab broadcast** — all connected clients see the stream (resume-aware exclusions)
- **Partial persistence** — on error, the partial assistant message is saved
- **Message sanitization** — strips ephemeral provider metadata before storage
- **Row size enforcement** — compacts tool outputs exceeding 1.8MB

## Workspace tools

File operation tools are built into Think and available to the model on every turn. For custom storage backends, the individual tool factories are also exported:

```ts
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

// Use with a custom ReadOperations/WriteOperations implementation
const tools = createWorkspaceTools(myCustomStorage);
```

Each tool is an AI SDK `tool()` with Zod schemas. The underlying operations are abstracted behind interfaces (`ReadOperations`, `WriteOperations`, etc.) so you can create tools backed by any storage.

## Code execution tool

Let the LLM write and run JavaScript in a sandboxed Worker:

```ts
import { createExecuteTool } from "@cloudflare/think/tools/execute";

getTools() {
  return {
    execute: createExecuteTool({ tools: wsTools, loader: this.env.LOADER })
  };
}
```

Requires `@cloudflare/codemode` and a `worker_loaders` binding in `wrangler.jsonc`.

## Extensions

Dynamic tool loading at runtime. The LLM can write extension source code, load it as a sandboxed Worker, and use the new tools on the next turn.

```ts
import { ExtensionManager } from "@cloudflare/think/extensions";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";

const extensions = new ExtensionManager({ loader: this.env.LOADER });

getTools() {
  return {
    ...createExtensionTools({ manager: extensions }),
    ...extensions.getTools()
  };
}
```

## Peer dependencies

| Package                | Required | Notes                            |
| ---------------------- | -------- | -------------------------------- |
| `agents`               | yes      | Cloudflare Agents SDK            |
| `ai`                   | yes      | Vercel AI SDK v6                 |
| `zod`                  | yes      | Schema validation (v3.25+ or v4) |
| `@cloudflare/shell`    | yes      | Workspace filesystem             |
| `@cloudflare/codemode` | optional | For `createExecuteTool`          |

## Acknowledgments

Think's design is inspired by [pi](https://pi.dev).
