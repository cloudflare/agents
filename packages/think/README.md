# @cloudflare/think

An Agent base class for AI assistants on Cloudflare Workers. Handles the full chat lifecycle — session management, agentic loop, streaming, persistence, workspace tools, and extensions — all backed by Durable Object SQLite.

Works as both a **top-level agent** (WebSocket chat protocol for browser clients) and a **sub-agent** (RPC streaming from a parent agent).

> **Experimental** — requires the `"experimental"` compatibility flag.

## Quick start

```ts
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Workspace } from "@cloudflare/shell";

export class ChatSession extends Think<Env> {
  workspace = new Workspace({ sql: this.ctx.storage.sql });

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  getSystemPrompt() {
    return "You are a helpful coding assistant.";
  }

  getTools() {
    return createWorkspaceTools(this.workspace);
  }
}
```

That's it. `Think` handles the WebSocket chat protocol, session persistence, the agentic loop, message sanitization, and streaming. Connect from the browser with `useAgentChat` or `useChat` + `AgentChatTransport`.

## Exports

| Export                               | Description                                                     |
| ------------------------------------ | --------------------------------------------------------------- |
| `@cloudflare/think`                  | `Think` — the main class, plus types                            |
| `@cloudflare/think/session`          | `SessionManager` — conversation persistence with branching      |
| `@cloudflare/think/tools/workspace`  | `createWorkspaceTools()` — file operation tools                 |
| `@cloudflare/think/tools/execute`    | `createExecuteTool()` — sandboxed code execution via codemode   |
| `@cloudflare/think/tools/extensions` | `createExtensionTools()` — LLM-driven extension loading         |
| `@cloudflare/think/extensions`       | `ExtensionManager`, `HostBridgeLoopback` — extension runtime    |
| `@cloudflare/think/transport`        | `AgentChatTransport` — bridges `useChat` with Agent WebSocket   |
| `@cloudflare/think/message-builder`  | `applyChunkToParts()` — reconstruct UIMessage parts from chunks |

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
| `getWorkspace()`          | `null`                           | Workspace for extension host bridge   |

### Session management

Think manages multiple named sessions per agent instance. Sessions are created automatically on the first chat message, or explicitly:

```ts
session.createSession("research");
session.switchSession(sessionId);
session.getSessions(); // Session[]
session.deleteSession(id);
session.renameSession(id, "new name");
session.getCurrentSessionId();
```

### Sub-agent streaming via RPC

When used as a sub-agent, the `chat()` method runs a full turn and streams events via a callback:

```ts
// StreamCallback — implement as an RpcTarget in the parent
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}

const session = await this.subAgent(ChatSession, "agent-abc");
await session.chat("Summarize the project", relay, {
  tools: extraTools,
  signal: abortController.signal
});
```

### Dynamic configuration

Think accepts a `Config` type parameter for per-instance configuration persisted in SQLite:

```ts
type MyConfig = { modelTier: "fast" | "capable"; systemPrompt: string };

export class ChatSession extends Think<Env, MyConfig> {
  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }
}

// From the parent:
const session = await this.subAgent(ChatSession, "agent-abc");
await session.configure({ modelTier: "capable", systemPrompt: "..." });
```

### Production features

- **WebSocket protocol** — wire-compatible with `useAgentChat` / `useChat`
- **Multi-session** — create, switch, list, delete, rename conversations
- **Abort/cancel** — pass an `AbortSignal` or send a cancel message
- **Partial persistence** — on error, the partial assistant message is saved
- **Message sanitization** — strips ephemeral provider metadata before storage
- **Row size enforcement** — compacts tool outputs exceeding 1.8MB
- **Incremental persistence** — skips SQL writes for unchanged messages
- **Storage bounds** — set `maxPersistedMessages` to cap stored history

## SessionManager

Persistent conversation storage with tree-structured messages (branching) and compaction. Used internally by Think, but also usable standalone.

```ts
import { SessionManager } from "@cloudflare/think/session";

const sessions = new SessionManager(agent);
const session = sessions.create("my-chat");
sessions.append(session.id, userMessage);
const history = sessions.getHistory(session.id); // UIMessage[]
```

Also exports truncation utilities (`truncateHead`, `truncateTail`, `truncateMiddle`, `truncateLines`) for managing large tool outputs.

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
  const wsTools = createWorkspaceTools(this.workspace);
  return {
    ...wsTools,
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

const extensions = new ExtensionManager({
  loader: this.env.LOADER,
  workspace: this.workspace
});

getTools() {
  return {
    ...createWorkspaceTools(this.workspace),
    ...createExtensionTools({ manager: extensions }),
    ...extensions.getTools()
  };
}
```

Extensions get permission-gated workspace access via `HostBridgeLoopback`. Re-export it from your worker entry point:

```ts
export { HostBridgeLoopback } from "@cloudflare/think/extensions";
```

## Chat transport

Client-side transport that bridges `useChat` with Agent WebSocket streaming:

```tsx
import { AgentChatTransport } from "@cloudflare/think/transport";
import { useAgent } from "agents/react";
import { useChat } from "@ai-sdk/react";

const agent = useAgent({ agent: "ChatSession" });
const transport = useMemo(() => new AgentChatTransport(agent), [agent]);
const { messages, sendMessage, status } = useChat({ transport });
```

Options: `sendMethod` (RPC method name, default `"sendMessage"`), `resumeTimeout` (ms, default `500`). Call `transport.detach()` before switching agents.

## Message builder

Reconstruct `UIMessage` parts from stream chunks:

```ts
import { applyChunkToParts } from "@cloudflare/think/message-builder";

const msg = { id: "...", role: "assistant", parts: [] };
for (const chunk of streamChunks) {
  applyChunkToParts(msg.parts, chunk);
}
```

Handles all AI SDK chunk types: `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `source`, `file`, and more.

## Peer dependencies

| Package                | Required | Notes                             |
| ---------------------- | -------- | --------------------------------- |
| `agents`               | yes      | Cloudflare Agents SDK             |
| `ai`                   | yes      | Vercel AI SDK v6                  |
| `zod`                  | yes      | Schema validation (v3.25+ or v4)  |
| `@cloudflare/codemode` | optional | For `createExecuteTool`           |
| `@cloudflare/shell`    | optional | For shell execution in extensions |
