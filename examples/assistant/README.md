# Assistant

An orchestrator that spawns and manages specialized sub-agents, each backed by `Think` from `@cloudflare/think`. Chat directly with the orchestrator, or delegate tasks to sub-agents with different models, prompts, and tool access.

## Run it

```bash
npm install && npm start
```

## What it demonstrates

- **Orchestrator + sub-agent architecture** — parent agent spawns `Think` sub-agents via `subAgent()`
- **Dynamic configuration** — each sub-agent gets its own model tier, system prompt, and tool access level
- **Shared workspace** — sub-agents can read/write a shared `Workspace` owned by the orchestrator
- **MCP integration** — orchestrator connects to MCP servers and bridges tools to sub-agents
- **WebSocket chat protocol** — `Think` handles streaming, sessions, and persistence
- **Workspace browsing** — client-side file explorer for the shared workspace

## Key pattern

```ts
import { Think } from "@cloudflare/think";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Workspace } from "agents/experimental/workspace";

// Sub-agent — dynamically configured per instance
export class ChatSession extends Think<Env, AgentConfig> {
  workspace = new Workspace(this);

  getModel() {
    const config = this.getConfig();
    const tier = config?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }

  getTools() {
    return createWorkspaceTools(this.workspace);
  }
}

// Orchestrator spawns sub-agents
const session = await this.subAgent(ChatSession, "agent-abc");
await session.configure({ modelTier: "capable", systemPrompt: "..." });
await session.chat("Summarize the project", relay);
```

## Related

- [AI Chat example](../ai-chat/) — basic chat with tools and approval
- [`@cloudflare/think` README](../../packages/think/README.md) — Think API reference
