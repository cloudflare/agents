# Cloudflare Agents

[![npm version](https://img.shields.io/npm/v/agents)](https://www.npmjs.com/package/agents)
[![npm downloads](https://img.shields.io/npm/dw/agents)](https://www.npmjs.com/package/agents)

![npm install agents](assets/npm-install-agents.svg)

Agents are persistent, stateful execution environments for agentic workloads, powered by Cloudflare [Durable Objects](https://developers.cloudflare.com/durable-objects/). Each agent has its own state, storage, and lifecycle — with built-in support for real-time communication, scheduling, AI model calls, MCP, workflows, and more.

Agents hibernate when idle and wake on demand. You can run millions of them — one per user, per session, per game room — each costs nothing when inactive.

```sh
npm create cloudflare@latest -- --template cloudflare/agents-starter
```

Or add to an existing project:

```sh
npm install agents
```

**[Read the docs](https://developers.cloudflare.com/agents/)** — getting started, API reference, guides, and more.

## Quick Example

A counter agent with persistent state, callable methods, and real-time sync to a React frontend:

```typescript
// server.ts
import { Agent, routeAgentRequest, callable } from "agents";

export type CounterState = { count: number };

export class CounterAgent extends Agent<Env, CounterState> {
  initialState = { count: 0 };

  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  decrement() {
    this.setState({ count: this.state.count - 1 });
    return this.state.count;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

```tsx
// client.tsx
import { useAgent } from "agents/react";
import { useState } from "react";
import type { CounterAgent, CounterState } from "./server";

function Counter() {
  const [count, setCount] = useState(0);

  const agent = useAgent<CounterAgent, CounterState>({
    agent: "CounterAgent",
    onStateUpdate: (state) => setCount(state.count)
  });

  return (
    <div>
      <span>{count}</span>
      <button onClick={() => agent.stub.increment()}>+</button>
      <button onClick={() => agent.stub.decrement()}>-</button>
    </div>
  );
}
```

State changes sync to all connected clients automatically. Call methods like they're local functions.

## Features

| Feature               | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| **Persistent State**  | Syncs to all connected clients, survives restarts                      |
| **Callable Methods**  | Type-safe RPC via the `@callable()` decorator                          |
| **Scheduling**        | One-time, recurring, and cron-based tasks                              |
| **WebSockets**        | Real-time bidirectional communication with lifecycle hooks             |
| **AI Chat**           | Message persistence, resumable streaming, server/client tool execution |
| **MCP**               | Act as MCP servers or connect as MCP clients                           |
| **Workflows**         | Durable multi-step tasks with human-in-the-loop approval               |
| **Email**             | Receive and respond via Cloudflare Email Routing                       |
| **Code Mode**         | LLMs generate executable TypeScript instead of individual tool calls   |
| **SQL**               | Direct SQLite queries via Durable Objects                              |
| **React Hooks**       | `useAgent` and `useAgentChat` for frontend integration                 |
| **Vanilla JS Client** | `AgentClient` for non-React environments                               |

**Coming soon:** Realtime voice agents, web browsing (headless browser), sandboxed code execution, and multi-channel communication (SMS, messengers).

## Packages

| Package                                     | Description                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| [`agents`](packages/agents)                 | Core SDK — Agent class, routing, state, scheduling, MCP, email, workflows       |
| [`@cloudflare/ai-chat`](packages/ai-chat)   | Higher-level AI chat — persistent messages, resumable streaming, tool execution |
| [`hono-agents`](packages/hono-agents)       | Hono middleware for adding agents to Hono apps                                  |
| [`@cloudflare/codemode`](packages/codemode) | Experimental — LLMs write executable code to orchestrate tools                  |

## Examples

The [`examples/`](examples) directory has self-contained demos covering most SDK features — MCP servers/clients, workflows, email agents, webhooks, tic-tac-toe, resumable streaming, and more. The [`playground`](examples/playground) is the kitchen-sink showcase with everything in one UI.

There are also examples using the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) in [`openai-sdk/`](openai-sdk).

Run any example locally:

```sh
cd examples/playground
npm run dev
```

## Documentation

- [Full docs](https://developers.cloudflare.com/agents/) on developers.cloudflare.com
- [`docs/`](docs) directory in this repo (synced upstream)
- [Anthropic Patterns guide](guides/anthropic-patterns) — sequential, routing, parallel, orchestrator, evaluator
- [Human-in-the-Loop guide](guides/human-in-the-loop) — approval workflows with pause/resume

## Repository Structure

| Directory                                       | Description                                              |
| ----------------------------------------------- | -------------------------------------------------------- |
| [`packages/agents/`](packages/agents)           | Core SDK                                                 |
| [`packages/ai-chat/`](packages/ai-chat)         | AI chat layer                                            |
| [`packages/hono-agents/`](packages/hono-agents) | Hono integration                                         |
| [`packages/codemode/`](packages/codemode)       | Code Mode (experimental)                                 |
| [`examples/`](examples)                         | Self-contained demo apps                                 |
| [`openai-sdk/`](openai-sdk)                     | Examples using the OpenAI Agents SDK                     |
| [`guides/`](guides)                             | In-depth pattern tutorials                               |
| [`docs/`](docs)                                 | Markdown docs synced to developers.cloudflare.com        |
| [`site/`](site)                                 | Deployed websites (agents.cloudflare.com, AI playground) |
| [`design/`](design)                             | Architecture and design decision records                 |
| [`scripts/`](scripts)                           | Repo-wide tooling                                        |

## Development

Node 24+ required. Uses npm workspaces.

```sh
npm install          # install all workspaces
npm run build        # build all packages
npm run check        # full CI check (format, lint, typecheck, exports)
CI=true npm test     # run tests (vitest + vitest-pool-workers)
```

Changes to `packages/` need a changeset:

```sh
npx changeset
```

See [`AGENTS.md`](AGENTS.md) for deeper contributor guidance.

## Contributing

We are not accepting external pull requests at this time — the SDK is evolving quickly and we want to keep the surface area manageable. That said, we'd love to hear from you:

- **Bug reports & feature requests** — [open an issue](https://github.com/cloudflare/agents/issues)
- **Questions & ideas** — [start a discussion](https://github.com/cloudflare/agents/discussions)

## License

[MIT](LICENSE)
