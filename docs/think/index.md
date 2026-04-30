# Think (Experimental)

`@cloudflare/think` is an opinionated chat agent base class for Cloudflare Workers. It handles the full chat lifecycle — agentic loop, message persistence, streaming, tool execution, client tools, stream resumption, and extensions — all backed by Durable Object SQLite.

Think works as both a **top-level agent** (WebSocket chat to browser clients via `useAgentChat`) and a **sub-agent** (RPC streaming from a parent agent via `chat()`).

> **Experimental.** The API surface is stable but may evolve before graduating out of experimental.

## Quick Start

### Install

```sh
npm install @cloudflare/think agents ai @cloudflare/shell zod workers-ai-provider
```

### Server

```typescript
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

That is it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, client tool support, and workspace file tools.

### Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong>
          {msg.parts.map((part, i) =>
            part.type === "text" ? <span key={i}>{part.text}</span> : null
          )}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            "input"
          ) as HTMLInputElement;
          sendMessage({ text: input.value });
          input.value = "";
        }}
      >
        <input name="input" placeholder="Send a message..." />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

### wrangler.jsonc

```jsonc
{
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "class_name": "MyAgent", "name": "MyAgent" }]
  },
  "migrations": [{ "new_sqlite_classes": ["MyAgent"], "tag": "v1" }],
  "main": "src/server.ts"
}
```

## Think vs AIChatAgent

Both Think and [`AIChatAgent`](../chat-agents.md) extend `Agent` and speak the same `cf_agent_chat_*` WebSocket protocol. They serve different goals.

**AIChatAgent** is a protocol adapter. You override `onChatMessage` and are responsible for calling `streamText`, wiring tools, converting messages, and returning a `Response`. AIChatAgent handles the plumbing — message persistence, streaming, abort, resume — but the LLM call is entirely your concern.

**Think** is an opinionated framework. It makes decisions for you: `getModel()` returns the model, `getSystemPrompt()` or `configureSession()` sets the prompt, `getTools()` returns tools. The default `onChatMessage` runs the complete agentic loop. You override individual pieces, not the whole pipeline.

| Concern                | AIChatAgent                                                      | Think                                                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Minimal subclass**   | ~15 lines (wire `streamText` + tools + system prompt + response) | 3 lines (`getModel()` only)                                         |
| **Storage**            | Flat SQL table                                                   | Session: tree-structured messages, context blocks, compaction, FTS5 |
| **Regeneration**       | Destructive (old response deleted)                               | Non-destructive branching (old responses preserved)                 |
| **Context management** | Manual                                                           | Context blocks with LLM-writable persistent memory                  |
| **Sub-agent RPC**      | Not built in                                                     | `chat()` with `StreamCallback`                                      |
| **Programmatic turns** | `saveMessages()`                                                 | `saveMessages()` + `continueLastTurn()`                             |
| **Compaction**         | `maxPersistedMessages` (deletes oldest)                          | Non-destructive summaries via overlays                              |
| **Search**             | Not available                                                    | FTS5 full-text search per-session and cross-session                 |

### When to use AIChatAgent

- You need full control over the LLM call (RAG, multi-model, custom streaming)
- You are migrating from AI SDK v4 (`autoTransformMessages` provides the bridge)
- You want the `Response` return type for HTTP middleware or testing
- You are building a simple chatbot with no memory requirements

### When to use Think

- You want to ship fast (3-line subclass with everything wired)
- You need persistent memory (context blocks the model can read and write)
- You need long conversations (non-destructive compaction)
- You need conversation search (FTS5)
- You are building a sub-agent system (parent-child RPC with streaming)
- You need proactive agents (programmatic turns from scheduled tasks or webhooks)

## Configuration Overrides

| Method / Property       | Default                          | Description                                                                     |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `getModel()`            | throws                           | Return the `LanguageModel` to use                                               |
| `getSystemPrompt()`     | `"You are a helpful assistant."` | System prompt (fallback when no context blocks)                                 |
| `getTools()`            | `{}`                             | AI SDK `ToolSet` for the agentic loop                                           |
| `maxSteps`              | `10`                             | Max tool-call rounds per turn                                                   |
| `sendReasoning`         | `true`                           | Send reasoning chunks to chat clients                                           |
| `configureSession()`    | identity                         | Add context blocks, compaction, search, skills — see [Sessions](../sessions.md) |
| `messageConcurrency`    | `"queue"`                        | How overlapping submits behave — see [Client Tools](./client-tools.md)          |
| `waitForMcpConnections` | `false`                          | Wait for MCP servers before inference                                           |
| `chatRecovery`          | `true`                           | Wrap turns in `runFiber` for durable execution, including sub-agent turns       |

## Dynamic Configuration

`configure()` and `getConfig()` persist a JSON-serializable config blob in SQLite. It survives hibernation and restarts. Pass the config shape as a method-level generic for typed call sites:

```typescript
type MyConfig = { modelTier: "fast" | "capable"; theme: string };

export class MyAgent extends Think<Env> {
  getModel() {
    const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
    const models = {
      fast: "@cf/moonshotai/kimi-k2.6",
      capable: "@cf/meta/llama-4-scout-17b-16e-instruct"
    };
    return createWorkersAI({ binding: this.env.AI })(models[tier]);
  }
}
```

| Method                 | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `configure<T>(config)` | Persist a config object (type checked via the method generic) |
| `getConfig<T>()`       | Read the persisted configuration, or null if never configured |

Prefer `state` / `setState` from `Agent` when you want the value broadcast to connected clients. Use `configure` for private, server-side settings.

Expose configuration to the client via `@callable`:

```typescript
import { callable } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  @callable()
  updateConfig(config: MyConfig) {
    this.configure<MyConfig>(config);
  }
}
```

## Session Integration

Think uses [Session](../sessions.md) for conversation storage. Override `configureSession` to add persistent memory, compaction, search, and skills:

```typescript
import { Think, Session } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: { get: async () => "You are a helpful coding assistant." }
      })
      .withContext("memory", {
        description: "Important facts learned during conversation.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }
}
```

Think's `this.messages` getter reads directly from Session's tree-structured storage. Context blocks, compaction overlays, and search are all handled by Session. See the [Sessions documentation](../sessions.md) for the full API.

## Package Exports

| Export                               | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| `@cloudflare/think`                  | `Think`, `Session`, `Workspace` — main class + re-exports     |
| `@cloudflare/think/tools/workspace`  | `createWorkspaceTools()` — for custom storage backends        |
| `@cloudflare/think/tools/execute`    | `createExecuteTool()` — sandboxed code execution via codemode |
| `@cloudflare/think/tools/extensions` | `createExtensionTools()` — LLM-driven extension loading       |
| `@cloudflare/think/extensions`       | `ExtensionManager`, `HostBridgeLoopback` — extension runtime  |

## Peer Dependencies

| Package                | Required | Notes                   |
| ---------------------- | -------- | ----------------------- |
| `agents`               | yes      | Cloudflare Agents SDK   |
| `ai`                   | yes      | Vercel AI SDK v6        |
| `zod`                  | yes      | Schema validation (v4)  |
| `@cloudflare/shell`    | yes      | Workspace filesystem    |
| `@cloudflare/codemode` | optional | For `createExecuteTool` |

## Docs

- [Getting Started](./getting-started.md) — Build a Think agent step by step
- [Lifecycle Hooks](./lifecycle-hooks.md) — `beforeTurn`, `beforeStep`, `onStepFinish`, `onChunk`, `onChatResponse`, and more
- [Tools](./tools.md) — Workspace tools, code execution, extensions
- [Client Tools](./client-tools.md) — Browser-side tools, approvals, and concurrency
- [Sub-agents and Programmatic Turns](./sub-agents.md) — RPC streaming, `saveMessages`, recovery
