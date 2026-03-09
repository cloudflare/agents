# @cloudflare/think

Opinionated building blocks for AI assistants on Cloudflare Workers. Provides session management, workspace tools, sandboxed code execution, and a dynamic extension system — all backed by Durable Object SQLite.

> **Experimental** — requires the `"experimental"` compatibility flag.

## Exports

| Export                               | Description                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `@cloudflare/think/think-session`    | `ThinkSession` — sub-agent base class with agentic loop, streaming, and persistence   |
| `@cloudflare/think/agent`            | `AssistantAgent` — standalone agent with WebSocket chat protocol (useChat compatible) |
| `@cloudflare/think/session`          | `SessionManager` — conversation persistence with branching and compaction             |
| `@cloudflare/think/tools/workspace`  | `createWorkspaceTools()` — file operation tools for Workspace                         |
| `@cloudflare/think/tools/execute`    | `createExecuteTool()` — sandboxed code execution via codemode                         |
| `@cloudflare/think/tools/extensions` | `createExtensionTools()` — LLM-driven extension loading                               |
| `@cloudflare/think/extensions`       | `ExtensionManager`, `HostBridgeLoopback` — extension runtime                          |
| `@cloudflare/think/transport`        | `AgentChatTransport` — bridges useChat with Agent WebSocket streaming                 |
| `@cloudflare/think/message-builder`  | `applyChunkToParts()` — reconstruct UIMessage parts from stream chunks                |

## ThinkSession

A sub-agent base class designed to be spawned by a parent Agent via `subAgent()`. Each instance gets its own SQLite storage and runs the full chat lifecycle: persist user message, assemble context, call LLM, stream events, persist response.

```ts
import { ThinkSession } from "@cloudflare/think/think-session";
import { createWorkersAI } from "workers-ai-provider";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Workspace } from "agents/experimental/workspace";

export class ChatSession extends ThinkSession<Env> {
  workspace = new Workspace(this);

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
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

### Dynamic configuration

ThinkSession accepts a `Config` type parameter for per-instance configuration persisted in SQLite:

```ts
type MyConfig = { modelTier: "fast" | "capable"; systemPrompt: string };

export class ChatSession extends ThinkSession<Env, MyConfig> {
  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }
}

// From the parent agent:
const session = await this.subAgent(ChatSession, "agent-abc");
await session.configure({ modelTier: "capable", systemPrompt: "..." });
```

### Chat with streaming

The `chat()` method runs a full turn and streams events via a callback:

```ts
// StreamCallback interface — implement as an RpcTarget in the parent
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}

await session.chat("Summarize the project", myCallback, {
  tools: extraTools, // merged with getTools() for this turn only
  signal: abortController.signal
});
```

### Production features

- **Abort/cancel** — pass an `AbortSignal` to stop mid-stream
- **Partial persistence** — on error, the partial assistant message is saved
- **Message sanitization** — strips OpenAI ephemeral metadata before storage
- **Row size enforcement** — compacts tool outputs exceeding 1.8MB
- **Incremental persistence** — skips SQL writes for unchanged messages
- **Storage bounds** — set `maxPersistedMessages` to cap stored history

## AssistantAgent

A standalone agent with a built-in WebSocket chat protocol compatible with the AI SDK's `useChat` hook. Use this when you want a single agent that speaks directly to a browser client.

```ts
import { AssistantAgent } from "@cloudflare/think/agent";

export class MyAssistant extends AssistantAgent<Env> {
  getModel() {
    /* ... */
  }
  getSystemPrompt() {
    /* ... */
  }
  getTools() {
    /* ... */
  }
}
```

The protocol is wire-compatible with `@cloudflare/ai-chat`, so `useAgentChat` works unchanged on the client. AssistantAgent adds session management (create, switch, list, delete, rename) on top.

## SessionManager

Persistent conversation storage with tree-structured messages (branching) and compaction. Used internally by both ThinkSession and AssistantAgent.

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

Each tool is an AI SDK `tool()` with Zod schemas. The underlying operations are abstracted behind interfaces (`ReadOperations`, `WriteOperations`, etc.) so you can also create tools backed by custom storage.

## Code execution tool

Let the LLM write and run JavaScript in a sandboxed Worker with typed access to your tools:

```ts
import { createExecuteTool } from "@cloudflare/think/tools/execute";

getTools() {
  const wsTools = createWorkspaceTools(this.workspace);
  return {
    ...wsTools,
    execute: createExecuteTool({
      tools: wsTools,
      loader: this.env.LOADER
    })
  };
}
```

Requires `@cloudflare/codemode` and a `worker_loaders` binding in `wrangler.jsonc`. Network access is blocked by default.

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
    ...extensions.getTools() // tools from loaded extensions
  };
}
```

Extensions get permission-gated workspace access via `HostBridgeLoopback`. Re-export it from your worker entry point:

```ts
export { HostBridgeLoopback } from "@cloudflare/think/extensions";
```

## Chat transport

Client-side `ChatTransport` implementation that bridges the AI SDK's `useChat` hook with an Agent WebSocket connection. Handles request ID correlation, cancellation, stream resumption after reconnect, and idempotent cleanup.

```tsx
import { AgentChatTransport } from "@cloudflare/think/transport";
import { useAgent } from "agents/react";
import { useChat } from "@ai-sdk/react";

const agent = useAgent({ agent: "MyAssistant" });
const transport = useMemo(() => new AgentChatTransport(agent), [agent]);
const { messages, sendMessage, resumeStream, status } = useChat({ transport });
```

Speaks the wire protocol used by `ThinkSession.chat()` and `ChunkRelay` on the server (`stream-start`, `stream-event`, `stream-done`, `stream-resuming`, `cancel`).

Options:

- **`sendMethod`** — server-side RPC method name (default: `"sendMessage"`)
- **`resumeTimeout`** — ms to wait for stream-resuming response (default: `500`)

Call `transport.detach()` before switching agents to cleanly close the current stream.

## Message builder

Reconstruct `UIMessage` parts from stream chunks on the client:

```ts
import { applyChunkToParts } from "@cloudflare/think/message-builder";

const assistantMsg = { id: "...", role: "assistant", parts: [] };
for (const chunk of streamChunks) {
  applyChunkToParts(assistantMsg.parts, chunk);
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
| `just-bash`            | optional | For shell execution in extensions |
