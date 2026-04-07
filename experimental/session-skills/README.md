# Session Skills

Demonstrates on-demand skill loading from R2 using Think and the `SkillProvider` context provider.

> **Experimental** — this API will break between releases.

## How It Works

Skills are documents stored in R2. Their metadata (key + description) is rendered into the system prompt so the model always knows what's available. The full content is loaded on demand when the model calls `load_context`.

Think handles the entire chat lifecycle — streaming, tool calls, message persistence, and the WebSocket protocol. The server only defines the model, session configuration, and skills CRUD:

```typescript
import { Think } from "@cloudflare/think";
import type { Session } from "@cloudflare/think";
import { R2SkillProvider } from "agents/experimental/memory/session";

export class SkillsAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: { get: async () => "You are a helpful assistant." }
      })
      .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
      .withContext("skills", {
        provider: new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" })
      })
      .onCompaction(createCompactFunction({ ... }))
      .compactAfter(1000)
      .withCachedPrompt();
  }
}
```

The client uses `useAgentChat` for the chat interface and `useAgent<SkillsAgent>()` for typed RPC to the skills sidebar.

### Provider Hierarchy

The `SkillProvider` extends `ContextProvider`. Provider shape determines behavior — no flags needed:

| Provider                  | Methods                     | Behavior                                                 |
| ------------------------- | --------------------------- | -------------------------------------------------------- |
| `ContextProvider`         | `get()`                     | Readonly block in system prompt                          |
| `WritableContextProvider` | `get()`, `set()`            | Writable via `set_context` tool                          |
| `SkillProvider`           | `get()`, `load()`, `set?()` | Metadata in prompt, `load_context` + `set_context` tools |

### Generated Tools

- **`set_context`** — write to any writable block (e.g. save facts to memory)
- **`load_context`** — load a skill's full content by key (only when skill providers exist)

## The Example

Chat UI with a sidebar for creating, editing, and deleting skills. The model discovers skills from the system prompt and loads them via `load_context`.

1. Create a skill in the sidebar (e.g. "pirate" with content "Always talk like a pirate")
2. Ask the model to use it — it sees the skill listed and calls `load_context` to fetch the instructions

## Setup

```bash
npm install
npm start
```

Requires an R2 bucket. The dev server uses local R2 storage automatically.
