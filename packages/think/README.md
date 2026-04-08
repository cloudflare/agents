# @cloudflare/think

An opinionated chat agent base class for Cloudflare Workers. Handles the full chat lifecycle — agentic loop, streaming, persistence, client tools, stream resumption — all backed by Durable Object SQLite.

Works as both a **top-level agent** (WebSocket chat protocol for browser clients) and a **sub-agent** (RPC streaming from a parent agent).

> **Experimental** — requires the `"experimental"` compatibility flag.

## Quick start

```ts
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  getSystemPrompt() {
    return "You are a helpful coding assistant.";
  }
}
```

That's it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, client tool support, and workspace file tools. Connect from the browser with `useAgentChat` from `@cloudflare/ai-chat`.

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

### Override points

| Method                    | Default                          | Description                                     |
| ------------------------- | -------------------------------- | ----------------------------------------------- |
| `getModel()`              | throws                           | Return the `LanguageModel` to use               |
| `getSystemPrompt()`       | `"You are a helpful assistant."` | System prompt (fallback when no context blocks) |
| `getTools()`              | `{}`                             | AI SDK `ToolSet` for the agentic loop           |
| `getMaxSteps()`           | `10`                             | Max tool-call rounds per turn                   |
| `configureSession()`      | identity                         | Add context blocks, compaction, search, skills  |
| `assembleContext()`       | prune older tool calls           | Customize what's sent to the LLM                |
| `onChatMessage(options?)` | `streamText(...)`                | Full control over inference                     |
| `onChatResponse(result)`  | no-op                            | Post-turn lifecycle hook                        |
| `onChatError(error)`      | passthrough                      | Customize error handling                        |

### Client tools

Think supports client-defined tools that execute in the browser. The client sends tool schemas in the chat request body, and Think merges them with server tools automatically:

```ts
// Client sends:
{ messages: [...], clientTools: [{ name: "search", description: "Search the web" }] }

// In onChatMessage, the default implementation merges:
// workspace + getTools() + clientTools + session context tools + options.tools
```

When the LLM calls a client tool, the tool call chunk is sent to the client. The client executes it and sends back `CF_AGENT_TOOL_RESULT`. Think applies the result, persists the updated message, broadcasts `CF_AGENT_MESSAGE_UPDATED`, and optionally auto-continues the conversation (debounce-based — multiple rapid tool results coalesce into one continuation turn).

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

Think inherits MCP client support from the Agent base class. Set `waitForMcpConnections` to ensure MCP-discovered tools are available before `onChatMessage` runs:

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

Think accepts a `Config` type parameter for per-instance configuration persisted in SQLite:

```ts
type MyConfig = { modelTier: "fast" | "capable"; systemPrompt: string };

export class MyAgent extends Think<Env, MyConfig> {
  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }
}
```

### Production features

- **WebSocket protocol** — wire-compatible with `useAgentChat` from `@cloudflare/ai-chat`
- **Built-in workspace** — every agent gets `this.workspace` with file tools auto-wired
- **Stream resumption** — page refresh replays buffered chunks via `ResumableStream`
- **Client tools** — accept tool schemas from clients, handle results and approvals
- **Auto-continuation** — debounce-based continuation after tool results
- **MCP integration** — wait for MCP connections before inference
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
