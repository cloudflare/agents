# Assistant

A showcase of all Project Think features, built with `@cloudflare/think`.

## What this demonstrates

- **Think base class** — `getModel()`, `configureSession()`, `getTools()`, `maxSteps` for a batteries-included agent
- **Built-in workspace** — file tools (read, write, edit, find, grep, delete) auto-wired on every turn
- **Sandboxed code execution** — `createExecuteTool` lets the LLM write and run JavaScript in a Dynamic Worker via `@cloudflare/codemode`
- **Self-authored extensions** — `extensionLoader` + `createExtensionTools` let the agent create new tools at runtime
- **Persistent memory** — context blocks (`soul`, `memory`) the model can read and write across sessions
- **Non-destructive compaction** — older messages summarized when context overflows, originals preserved
- **Searchable knowledge base** — FTS5-backed `AgentSearchProvider` with `search_context` and `set_context` tools
- **Dynamic configuration** — typed `AgentConfig` with model tier and persona, persisted in SQLite
- **Server-side tools** — `getWeather`, `calculate` execute on the server
- **Client-side tools** — `getUserTimezone` runs in the browser via `onToolCall`
- **Tool approval** — `calculate` requires user approval for large numbers
- **MCP integration** — connect external tool servers, tools appear in the chat
- **Lifecycle hooks** — `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChatResponse`
- **Durable chat recovery** — `chatRecovery` wraps turns in fibers for crash recovery
- **Scheduled proactive turns** — daily summary via `saveMessages` from a cron schedule
- **Regeneration with branch navigation** — v1/v2/v3 response versions via `getBranches`
- **Stream resumption** — page refresh replays the active stream (built into Think)
- **useAgentChat** — Think speaks the same CF_AGENT protocol as AIChatAgent

## How to run

```bash
npm install
npm start
```

## Key code

**Server** (`src/server.ts`):

```typescript
export class MyAssistant extends Think<Env, AgentConfig> {
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  getModel() { /* model tier from config */ }
  configureSession(session) {
    return session
      .withContext("memory", { ... })
      .onCompaction(createCompactFunction({ ... }))
      .compactAfter(50000)
      .withContext("knowledge", { provider: new AgentSearchProvider(this) })
      .withCachedPrompt();
  }
  getTools() {
    return {
      execute: createExecuteTool({ ... }),
      ...createExtensionTools({ ... }),
      getWeather: tool({ ... }),
      calculate: tool({ needsApproval: ..., ... })
    };
  }
}
```

**Client** (`src/client.tsx`) — uses `useAgentChat` from `@cloudflare/ai-chat/react`, with panels for workspace browsing, extension management, and dynamic configuration.

## Related

- [Think docs](../../docs/think/index.md)
- [Think tools](../../docs/think/tools.md)
- [Think lifecycle hooks](../../docs/think/lifecycle-hooks.md)
