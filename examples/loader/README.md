# Think

**A reasoning engine that acts.**

Think is a cloud-native agent runtime you can embed in your applications. It doesn't just respond to prompts—it reasons through problems by writing code, executing it, observing results, and iterating. It persists across time, reacts to events, and works while you sleep.

Most AI integrations are stateless one-shots: user asks, AI responds, done. Think is different. It's an ongoing presence in your system—a colleague that investigates issues, monitors for changes, and picks up where it left off, whether that's minutes or months later.

Give your app the ability to think. And do.

---

## What Can It Do?

**Think** — Reasons through problems using LLM capabilities with full tool use

**Do** — Acts on its reasoning:

- Writes and executes code in a sandboxed JavaScript environment
- Runs shell commands via bash
- Reads, writes, and edits files with full version history
- Browses the web with a real browser (Playwright)
- Searches the web and news
- Delegates work to parallel subagents

**Persist** — Maintains state across interactions:

- Remembers conversation history and context
- Stores files with CRDT-based versioning (Yjs)
- Hibernates efficiently when idle, wakes when needed
- Works on problems for hours, days, or indefinitely

**React** — Responds to the world:

- Webhooks (GitHub, Stripe, your APIs)
- Scheduled triggers (cron, delayed tasks)
- Real-time messages via WebSocket
- Communication channels (future: Slack, Discord, email)

---

## Who Is This For?

**Developers building AI-powered products.** If you've used local coding agents like Cursor, Claude Code, or Devin—and wished you could give that capability to your users—Think is for you.

**Teams who want agent capabilities without building from scratch.** Think handles the hard parts: tool orchestration, state persistence, hibernation, parallel execution, security sandboxing.

**Anyone who wants their app to solve problems it wasn't explicitly programmed to solve.** Think can approach novel situations by writing code to investigate and resolve them.

---

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- OpenAI API key (for LLM)
- Brave Search API key (optional, for web search)

### Setup

```bash
# Clone the repository
git clone https://github.com/cloudflare/agents-repo.git
cd agents-repo/examples/loader

# Install dependencies
npm install

# Configure your environment
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys

# Start the development server
npm run dev
```

### First Interaction

```bash
# Send a message to Think
curl -X POST http://localhost:8787/agents/think/my-session/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a simple hello world function and test it"}'
```

Think will:

1. Write the function
2. Execute it to verify it works
3. Report back with the results

---

## Extend & Customize

Think is opinionated but extensible. The core capabilities are fixed, but you can augment them through class extension or runtime props.

### Class Extension (for building products)

```typescript
import { Think } from "./server";

class CustomerServiceThink extends Think {
  // Add domain-specific instructions
  protected getAdditionalInstructions(): string {
    return `You are helping Acme Corp customers.
Always check order status before discussing refunds.`;
  }

  // Add domain-specific tools
  protected getCustomTools() {
    return {
      lookupOrder: this.orderLookupTool(),
      refundOrder: this.refundTool()
    };
  }
}
```

### Runtime Props (for per-request customization)

```typescript
import { getAgentByName } from "agents";

// Customize per user/tenant at runtime
const agent = await getAgentByName(env.Think, `user-${userId}`, {
  props: {
    additionalInstructions: "This user prefers concise answers.",
    models: {
      primary: "claude-3-opus",
      fast: "claude-haiku"
    }
  }
});
```

See [design.md](./design.md) for the full extensibility architecture.

---

## How It Works

Think is built on Cloudflare's Durable Objects, giving it persistent state, WebSocket connections, and automatic hibernation.

```
┌─────────────────────────────────────────┐
│           Think (Durable Object)        │
│                                         │
│  • Persistent state & SQLite storage    │
│  • WebSocket for real-time streaming    │
│  • Scheduled tasks & hibernation        │
│  • Yjs document for versioned files     │
│                                         │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│        Sandboxed Code Execution         │
│                                         │
│  Dynamic workers via LOADER binding     │
│  • No direct network access             │
│  • Only tools we explicitly provide     │
│  • Millisecond cold starts              │
│                                         │
└─────────────────────────────────────────┘
```

The key insight: instead of orchestrating predefined tools, Think can solve novel problems by writing and executing code. It's not limited to what we anticipated—it can figure things out.

---

## Security

Think runs untrusted code safely:

- **Sandboxed execution**: Dynamic workers have no network access by default
- **Controlled capabilities**: Tools are explicitly provided via loopback bindings
- **Isolated storage**: Executed code cannot access Think's internal state
- **Action logging**: Full audit trail of all tool calls
- **Allowlists**: Fetch and bash have configurable restrictions

---

## Status

**Working Now:**

- ✅ Full LLM agent loop with 13+ tools
- ✅ Code execution in sandboxed isolates
- ✅ Bash, files, fetch, web search, browser automation
- ✅ Real-time streaming via WebSocket
- ✅ Task management with dependencies
- ✅ Subagent delegation for parallel work
- ✅ Hibernation-aware scheduling and recovery
- ✅ Action logging and audit trail

**Coming Soon:**

- 🔜 Three-layer extensibility (core/class/props)
- 🔜 Multi-model routing (primary/fast/vision/summarizer)
- 🔜 Chat UI
- 🔜 Full Yjs sync protocol for multiplayer editing

See [plan.md](./plan.md) for the detailed roadmap.

---

## Built With

- [Cloudflare Workers](https://workers.cloudflare.com/) & [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Agents SDK](https://github.com/cloudflare/agents) — Agent primitives for Cloudflare
- [Vercel AI SDK](https://sdk.vercel.ai/) — LLM integration and streaming
- [Yjs](https://yjs.dev/) — CRDT-based collaborative editing
- [Playwright](https://playwright.dev/) — Browser automation
- [just-bash](https://github.com/porsager/just-bash) — Shell execution in isolates

---

## Inspiration

Think builds on ideas from:

- **[Pi](https://pi.dev)** — Minimal core (read, write, edit, bash), self-modifying agents
- **[OpenClaw](https://openclaw.ai)** — Code writing code, dynamic skill loading
- **[Minions](https://github.com/polterguy/magic)** — Loopback bindings, Yjs storage, human-in-the-loop patterns

---

## Learn More

- [design.md](./design.md) — Architecture, extensibility, security model
- [plan.md](./plan.md) — Implementation status and roadmap
- [Agents Documentation](https://developers.cloudflare.com/agents/) — Cloudflare Agents SDK

---

## License

MIT
