# Getting Started with Think

Build a chat agent with persistent memory, built-in file tools, and streaming — step by step.

By the end of this tutorial you will have a Think agent that:

- Streams responses to a React chat UI
- Has persistent memory the model can read and write
- Includes workspace file tools (read, write, edit, find, grep, delete)
- Supports custom server-side tools

## Prerequisites

- Node.js 24+
- A Cloudflare account with Workers AI access
- Familiarity with TypeScript and Cloudflare Workers

## 1. Create a project

```sh
mkdir my-think-agent && cd my-think-agent
npm init -y
```

Install dependencies:

```sh
npm install @cloudflare/think @cloudflare/ai-chat agents ai @cloudflare/shell zod workers-ai-provider react react-dom
npm install -D wrangler @cloudflare/vite-plugin @cloudflare/workers-types @vitejs/plugin-react @tailwindcss/vite tailwindcss typescript vite
```

## 2. Configure wrangler

Create `wrangler.jsonc`:

```jsonc
{
  "name": "my-think-agent",
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "ai": { "binding": "AI" },
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/agents/*"]
  },
  "durable_objects": {
    "bindings": [{ "class_name": "MyAgent", "name": "MyAgent" }]
  },
  "migrations": [{ "new_sqlite_classes": ["MyAgent"], "tag": "v1" }],
  "main": "src/server.ts"
}
```

The `"experimental"` compatibility flag is required for Think.

Create `vite.config.ts`:

```typescript
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare(), tailwindcss()]
});
```

Create `tsconfig.json`:

```json
{
  "extends": "agents/tsconfig"
}
```

## 3. Define the agent

Create `src/server.ts`:

```typescript
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  getSystemPrompt() {
    return "You are a helpful assistant with access to a workspace filesystem.";
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

This is a working agent. Think automatically provides:

- WebSocket chat protocol (compatible with `useAgentChat`)
- Message persistence in SQLite
- Resumable streaming (page refresh replays buffered chunks)
- Workspace file tools (read, write, edit, list, find, grep, delete)
- Abort/cancel support
- Error handling with partial message persistence

## 4. Connect a React client

Create `src/client.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 20 }}>
      <h1>Think Agent</h1>

      <div>
        {messages.map((msg) => (
          <div key={msg.id} style={{ margin: "12px 0" }}>
            <strong>{msg.role}:</strong>{" "}
            {msg.parts.map((part, i) =>
              part.type === "text" ? <span key={i}>{part.text}</span> : null
            )}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            "input"
          ) as HTMLInputElement;
          if (!input.value.trim()) return;
          sendMessage({ text: input.value });
          input.value = "";
        }}
      >
        <input
          name="input"
          placeholder="Send a message..."
          style={{ width: "80%", padding: 8 }}
        />
        <button type="submit" style={{ padding: 8 }}>
          Send
        </button>
      </form>

      <p style={{ fontSize: 12, color: "#666" }}>Status: {status}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Chat />);
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Think Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client.tsx"></script>
  </body>
</html>
```

## 5. Run it

```sh
npx vite dev
```

Open the browser and send a message. The agent responds with streaming text, and workspace file tools are available to the model automatically.

## 6. Add persistent memory

Override `configureSession` to give the model writable memory that survives restarts:

```typescript
export class MyAgent extends Think<Env> {
  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            "You are a helpful assistant. Remember important facts about the user."
        }
      })
      .withContext("memory", {
        description: "Important facts about the user and conversation.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }
}
```

Now the model sees a `MEMORY` section in its system prompt and gets a `set_context` tool to update it. Facts written to memory persist in SQLite and survive DO hibernation and restarts.

When you use `configureSession`, the system prompt is built from context blocks rather than `getSystemPrompt()`. The `"soul"` block above acts as the system identity — it is read-only and always appears first. The `"memory"` block is writable, and the model proactively updates it when it learns something useful.

See the [Sessions documentation](../sessions.md) for context blocks, compaction, search, skills, and multi-session support.

## 7. Add custom tools

Override `getTools()` to add your own tools alongside the built-in workspace tools:

```typescript
import { tool } from "ai";
import { z } from "zod";

export class MyAgent extends Think<Env> {
  getModel(): LanguageModel {
    /* ... */
  }
  configureSession(session: Session) {
    /* ... */
  }

  getTools(): ToolSet {
    return {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          const res = await fetch(
            `https://api.weatherapi.com/v1/current.json?key=${this.env.WEATHER_KEY}&q=${city}`
          );
          return res.json();
        }
      })
    };
  }
}
```

Think merges tools from multiple sources automatically. On every turn, the model has access to:

1. **Workspace tools** — read, write, edit, list, find, grep, delete (built-in)
2. **Session tools** — set_context, load_context, search_context (from `configureSession`)
3. **Your tools** — from `getTools()`
4. **MCP tools** — from connected MCP servers (if any)
5. **Client tools** — from the browser (if any)

## 8. Add lifecycle hooks

Think provides hooks that fire on every turn, regardless of entry path:

```typescript
import type {
  TurnContext,
  TurnConfig,
  ChatResponseResult
} from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  getModel(): LanguageModel {
    /* ... */
  }

  beforeTurn(ctx: TurnContext): TurnConfig | void {
    console.log(
      `Turn starting: ${Object.keys(ctx.tools).length} tools available`
    );
  }

  onChatResponse(result: ChatResponseResult) {
    console.log(`Turn ${result.status}: ${result.message.parts.length} parts`);
  }
}
```

See [Lifecycle Hooks](./lifecycle-hooks.md) for the full reference.

## Next Steps

- [Lifecycle Hooks](./lifecycle-hooks.md) — control model behavior, switch models per-turn, restrict tools
- [Tools](./tools.md) — workspace tools, code execution, extensions
- [Client Tools](./client-tools.md) — browser-side tools, approval flows, concurrency
- [Sub-agents and Programmatic Turns](./sub-agents.md) — RPC streaming, scheduled turns, recovery
- [Sessions](../sessions.md) — context blocks, compaction, search, multi-session
