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

That's it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, and client tool support. Connect from the browser with `useAgentChat` from `@cloudflare/ai-chat`.

## Exports

| Export                               | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| `@cloudflare/think`                  | `Think` — the main class, plus types                          |
| `@cloudflare/think/tools/workspace`  | `createWorkspaceTools()` — file operation tools               |
| `@cloudflare/think/tools/execute`    | `createExecuteTool()` — sandboxed code execution via codemode |
| `@cloudflare/think/tools/extensions` | `createExtensionTools()` — LLM-driven extension loading       |
| `@cloudflare/think/extensions`       | `ExtensionManager`, `HostBridgeLoopback` — extension runtime  |

## Think

### Override points

| Method                    | Default                          | Description                           |
| ------------------------- | -------------------------------- | ------------------------------------- |
| `getModel()`              | throws                           | Return the `LanguageModel` to use     |
| `getSystemPrompt()`       | `"You are a helpful assistant."` | System prompt                         |
| `getTools()`              | `{}`                             | AI SDK `ToolSet` for the agentic loop |
| `getMaxSteps()`           | `10`                             | Max tool-call rounds per turn         |
| `assembleContext()`       | prune older tool calls           | Customize what's sent to the LLM      |
| `onChatMessage(options?)` | `streamText(...)`                | Full control over inference           |
| `onChatError(error)`      | passthrough                      | Customize error handling              |

### Client tools

Think supports client-defined tools that execute in the browser. The client sends tool schemas in the chat request body, and Think merges them with server tools automatically:

```ts
// Client sends:
{ messages: [...], clientTools: [{ name: "search", description: "Search the web" }] }

// In onChatMessage, the default implementation merges:
// getTools() + clientTools + options.tools
```

When the LLM calls a client tool, the tool call chunk is sent to the client. The client executes it and sends back `CF_AGENT_TOOL_RESULT`. Think applies the result, persists the updated message, broadcasts `CF_AGENT_MESSAGE_UPDATED`, and optionally auto-continues the conversation (debounce-based — multiple rapid tool results coalesce into one continuation turn).

Tool approval flows are also supported via `CF_AGENT_TOOL_APPROVAL`.

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
- **Stream resumption** — page refresh replays buffered chunks via `ResumableStream`
- **Client tools** — accept tool schemas from clients, handle results and approvals
- **Auto-continuation** — debounce-based continuation after tool results
- **MCP integration** — wait for MCP connections before inference
- **Abort/cancel** — pass an `AbortSignal` or send a cancel message
- **Multi-tab broadcast** — all connected clients see the stream (resume-aware exclusions)
- **Partial persistence** — on error, the partial assistant message is saved
- **Message sanitization** — strips ephemeral provider metadata before storage
- **Row size enforcement** — compacts tool outputs exceeding 1.8MB
- **Incremental persistence** — skips SQL writes for unchanged messages
- **Storage bounds** — set `maxPersistedMessages` to cap stored history
- **Messages on connect** — newly connected clients receive the current message list immediately

## Workspace tools

File operation tools backed by the Agents SDK `Workspace`:

```ts
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

const tools = createWorkspaceTools(this.workspace);
// Tools: read, write, edit, list, find, grep, delete
```

Each tool is an AI SDK `tool()` with Zod schemas. The underlying operations are abstracted behind interfaces (`ReadOperations`, `WriteOperations`, etc.) so you can create tools backed by custom storage.

## Code execution tool

Let the LLM write and run JavaScript in a sandboxed Worker:

```ts
import { createExecuteTool } from "@cloudflare/think/tools/execute";

getTools() {
  return {
    ...createWorkspaceTools(this.workspace),
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
| `@cloudflare/codemode` | optional | For `createExecuteTool`          |
| `@cloudflare/shell`    | optional | For workspace tools              |
