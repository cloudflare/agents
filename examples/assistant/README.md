# Assistant

A chat agent built with `@cloudflare/think` — the opinionated chat agent base class for Cloudflare Workers.

## What this demonstrates

- **Think overrides** — `getModel()`, `getSystemPrompt()`, `getTools()` for a batteries-included agent
- **Workspace tools** — read, write, edit, find, grep files in the DO's SQLite filesystem
- **Server-side tools** — `getWeather` executes on the server automatically
- **Client-side tools** — `getUserTimezone` runs in the browser via `onToolCall`
- **Tool approval** — `calculate` requires user approval for large numbers
- **MCP integration** — connect external tool servers, tools appear in the chat
- **Stream resumption** — page refresh replays the active stream (built into Think)
- **useAgentChat** — Think speaks the same CF_AGENT protocol as AIChatAgent

## How to run

```bash
npm install
npm start
```

## Key code

**Server** (`src/server.ts`) — ~150 lines:

```typescript
export class MyAssistant extends Think<Env> {
  workspace = new Workspace({ sql: this.ctx.storage.sql, name: () => this.name });
  waitForMcpConnections = true;

  getModel() { return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5"); }
  getSystemPrompt() { return "You are a helpful assistant..."; }
  getTools() { return { ...createWorkspaceTools(this.workspace), ...this.mcp.getAITools(), ... }; }
}
```

**Client** (`src/client.tsx`) — uses `useAgentChat` from `@cloudflare/ai-chat/react`, which works with both Think and AIChatAgent out of the box.
