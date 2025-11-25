A small but opinionated agent runtime built on top of **Cloudflare Workers**, **Durable Objects**, and the **Agents SDK**.

You get:

- A durable, per-thread “system agent” running inside a Durable Object
- A multi-tenant **Agency** control-plane DO that manages agents and blueprints
- A tool/middleware system for planning, filesystem access, and subagents
- A built-in web **dashboard** for chat, state inspection, and an execution graph
- A simple way to plug in your LLM provider (defaults to OpenAI via `LLM_API_KEY`)

The example in `examples/deep/` shows how to drive Cloudflare Analytics with a manager agent that spawns specialized security subagents.

---

## Quick mental model

- Each **thread** is a Durable Object instance of `SystemAgent`
- Each agent is configured via an **AgentBlueprint**: prompt, model, tags, config
- **AgentSystem** wires it all together:
  - registers tools & middleware
  - registers blueprints
  - exports:
    - `SystemAgent` DO class
    - `Agency` DO class
    - HTTP `handler` for agencies, agents, and the dashboard

Agents are long‑lived (they keep SQL + KV state), can call tools, spawn subagents, and are observable through an event log and a live WebSocket stream.

---

## Features

- **Durable per-thread runtime**
  - Messages, events, files, and run state live in DO SQLite + KV
  - Runs are resumed via Durable Object alarms

- **Blueprint-based agents**
  - Define named agent types with their own prompt, model & config
  - Tag-based selection of middleware and tools

- **Built-in middleware**
  - `planning`: todo list / task planner
  - `filesystem`: virtual filesystem tools (`ls`, `read_file`, `write_file`, `edit_file`)
  - `subagents`: task-spawning tool (`task`) that runs subagents in parallel
  - `hitl` (optional): human-in-the-loop gating for specific tools

- **Subagents / “tasks”**
  - `task` tool launches a fresh agent thread with its own context window
  - Parent run pauses until all child subagents report back
  - Results come back as tool messages in the parent

- **Dashboard UI (client.html)**
  - Thread list (root agents + subagent tree)
  - Chat transcript with tool call expanders
  - Live execution graph (model/tool ticks + subagent edges)
  - Todos + filesystem viewer
  - HITL controls and run status

---

## Example

Minimal example that defines one manager agent and enables the default middleware set:

```ts
// src/index.ts
import { AgentSystem } from "agents/sys";

const system = new AgentSystem({
  defaultModel: "openai:gpt-4.1-mini" // or whatever your provider expects
})
  .defaults() // planning + filesystem + subagents
  .addAgent({
    name: "manager-agent",
    description: "Generic manager/orchestrator agent.",
    prompt: "You are a helpful assistant.",
    tags: ["default"]
  });

const { SystemAgent, Agency, handler } = system.export();

// Cloudflare Worker export surface
export { SystemAgent, Agency };
export default handler;
```

Then bind the Durable Objects / KV in `wrangler.jsonc` (see **Getting Started**), set `LLM_API_KEY`, deploy, and open the Worker URL in a browser to use the dashboard.

---

## TODOS:

- [ ] Add tools at runtime with MCP
- [ ] Better way to distribute the client. Just react and build it every time?
- [ ] Write a TS client
- [ ] Replace DO SQlite and use R2 for the filesystem
- [ ] Persist events in R2

## Docs

- [Getting Started](../../../../docs/sys//getting-started.md) – set up a Worker, bind DOs, run the dashboard
- [Architecture](../../../../docs/sys/architecture.md) – how Agencies, SystemAgents, middleware, and subagents fit together
- [API Reference](../../../../docs/sys/api-reference.md) – types, classes, middleware, tools, HTTP endpoints
