# Project Think: Building the Next Generation of AI Agents on Cloudflare

_Announcing a preview of the next edition of the Agents SDK — from lightweight primitives to a batteries-included platform for AI agents that think, act, and persist._

---

## What coding agents taught us

Something happened in 2025 that changed how we think about AI. Tools like [Pi](https://github.com/nichochar/pi-mono), [OpenClaw](https://github.com/openclaw), [Claude Code](https://docs.anthropic.com/en/docs/agents), and [Codex](https://openai.com/codex) proved a simple but powerful idea: give an LLM the ability to read files, write code, execute it, and remember what it learned, and you get a general-purpose machine.

These coding agents aren't just writing code. People are using them to manage calendars, analyze datasets, negotiate purchases, file taxes, and automate entire business workflows. The pattern is always the same: the agent reads context, reasons about it, writes code to take action, observes the result, and iterates. Code is the universal medium of action.

But every one of these tools shares the same fundamental limitation: they run on your laptop.

That means:

- **One user per machine** — or an expensive VPS per user
- **Always-on hardware** — $50-200/month whether the agent is working or not
- **No hibernation** — you're paying for idle time
- **Local-only state** — no sharing, no collaboration, no handoff between devices
- **Manual setup** — installing dependencies, managing updates, configuring environments

What if every person could have an agent like this — not running on their laptop, but running on the internet? What if it cost nothing when idle, woke up instantly on a message, persisted its memory across sessions, and could scale to millions of users without changing a line of code?

That's what we're building.

## Introducing Project Think

Project Think is the next edition of the Cloudflare Agents SDK. It represents a shift from a toolkit of primitives — Durable Objects, WebSockets, state sync, scheduling — to a complete, opinionated framework for building AI agents that think, act, and persist.

The name is deliberate. These aren't stimulus-response chatbots. They're agents that plan across long horizons, checkpoint their progress, survive infrastructure failures, and pick up exactly where they left off. They think.

Here's the stack:

| Capability               | What it does                     | Powered by                                              |
| ------------------------ | -------------------------------- | ------------------------------------------------------- |
| Per-agent isolation      | Every agent is its own world     | Durable Objects                                         |
| Zero cost when idle      | $0 until the agent wakes up      | Hibernation                                             |
| Persistent state         | Queryable, transactional storage | DO SQLite                                               |
| Durable filesystem       | Files that survive restarts      | Workspace (SQLite + R2)                                 |
| Sandboxed code execution | Run LLM-generated code safely    | Dynamic Isolates                                        |
| Runtime dependencies     | `import cheerio` just works      | workers-builder                                         |
| Web automation           | Browse, scrape, fill forms       | Browser Rendering                                       |
| Full OS access           | git, compilers, test runners     | [Sandboxes](https://developers.cloudflare.com/sandbox/) |
| Scheduled execution      | Proactive, not just reactive     | DO Alarms + Fibers                                      |
| Real-time streaming      | Token-by-token to any client     | WebSockets                                              |
| External tools           | Connect to any tool server       | MCP                                                     |
| Agent coordination       | Typed RPC between agents         | Sub-agents (Facets)                                     |
| Structural security      | Impossible, not just unlikely    | Gatekeepers + Facets                                    |

Each of these is a building block. Together, they form something new:

```
┌──────────────── AssistantAgent (Durable Object) ────────────────┐
│                                                                 │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Workspace │  │   Sessions   │  │        Memory            │  │
│  │ (files,   │  │  (tree,      │  │  (long-term facts,       │  │
│  │  R2 spill)│  │   branches)  │  │   embeddings)            │  │
│  └─────┬─────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│        └───────────────┼───────────────────────┘                │
│                        ▼                                        │
│              ┌──────────────────┐                               │
│              │   Agentic Loop   │                               │
│              │  context → model │                               │
│              │  → tools → loop  │                               │
│              └────────┬─────────┘                               │
│                       ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                       Tools                              │   │
│  │  Workspace I/O │ Dynamic Isolate │ Browser │ Sandbox     │   │
│  │  Extensions    │ MCP servers     │ Sub-agents            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌────────┐  ┌───────────┐  ┌────────────────────────────────┐  │
│  │ Fibers │  │ Scheduler │  │         Gatekeepers            │  │
│  │(durable│  │ (alarms,  │  │  (approval queues, isolation,  │  │
│  │  exec) │  │  cron)    │  │   audit trail)                 │  │
│  └────────┘  └───────────┘  └────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           WebSocket + HTTP + Webhooks                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
       ↑ WS              ↑ HTTP             ↑ Webhook
  ┌────┴────┐      ┌─────┴─────┐       ┌────┴─────────┐
  │ Web UI  │      │ Telegram  │       │ Slack/Email  │
  └─────────┘      └───────────┘       └──────────────┘
```

A platform where anyone can build, deploy, and run AI agents as capable as the ones running on your local machine today — but serverless, durable, and safe.

Let's walk through the key ideas.

## The Execution Ladder

Not every task needs the same level of capability. A question about a file doesn't require a sandbox. A data transformation doesn't require a browser. Project Think introduces an execution ladder — a spectrum of compute environments that the agent escalates through as needed.

```
┌─────────────────────────────────────────────────────────┐
│                   Tier 4 — Sandbox                      │
│        git, compilers, test runners, Python             │
├─────────────────────────────────────────────────────────┤
│                 Tier 3 — Browser                        │
│          scrape, navigate, screenshot, fill             │
├─────────────────────────────────────────────────────────┤
│             Tier 2 — Isolate + npm                      │
│       JS with runtime-resolved npm dependencies         │
├─────────────────────────────────────────────────────────┤
│              Tier 1 — Dynamic Isolate                   │
│         LLM-generated JS, sandboxed, no network         │
├─────────────────────────────────────────────────────────┤
│               Tier 0 — Workspace                        │
│      read, write, edit, find, grep, bash, diff          │
└─────────────────────────────────────────────────────────┘
          ▲ escalates as needed, additive
          │ most tasks never leave Tier 0
```

### Tier 0 — Workspace

The foundation. Every agent gets a durable virtual filesystem backed by SQLite (for small files, zero-latency reads) and R2 (for large files, unlimited storage). The agent can read, write, edit, search, grep, diff, and list files — all the operations a coding agent needs to understand and modify a codebase.

```typescript
import {
  AssistantAgent,
  Workspace,
  createWorkspaceTools
} from "agents/experimental/assistant";

class MyAgent extends AssistantAgent<Env> {
  workspace = new Workspace(this, { r2: this.env.R2 });

  getTools() {
    return createWorkspaceTools(this.workspace);
  }
}
```

Six lines. The agent can now read any file, write any file, find files by glob, search contents by regex, and edit files with fuzzy matching. The Workspace persists across hibernation, survives restarts, and costs nothing when idle.

The Workspace also includes a sandboxed bash interpreter. Shell scripts run against the virtual filesystem — `cat /src/index.ts` reads from the same storage as `workspace.readFile("/src/index.ts")`. Bash sessions preserve `cwd` and environment variables across calls, so multi-step workflows work naturally.

Most agent tasks never need to leave Tier 0.

### Tier 1 — Dynamic Isolate

When the agent needs to compute — transform data, validate input, run a regex across a thousand files — it writes JavaScript and executes it in a Dynamic Isolate. This is a fresh V8 isolate with millisecond startup, no network access, and a single binding back to the host agent.

The LLM doesn't make tool calls one at a time. It writes code that calls tools programmatically:

```javascript
// The LLM writes this code, which runs in a sandboxed isolate
const files = await tools.find({ pattern: "**/*.ts" });
const results = [];
for (const file of files) {
  const content = await tools.read({ path: file });
  if (content.includes("TODO")) {
    results.push({ file, todos: content.match(/\/\/ TODO:.*/g) });
  }
}
return results;
```

This is fundamentally different from sequential tool calling. Instead of 100 round-trips to the LLM (one per file), the LLM writes a single program that handles the entire task. Fewer tokens, faster execution, better results.

The isolate runs in the Cloudflare runtime with `globalOutbound: null` — it literally cannot make network requests. The only thing it can do is call the tools the host provides. Security is structural, not behavioral.

### Tier 2 — Isolate + npm

Same as Tier 1, but the code can `import` npm packages. At runtime, `workers-builder` fetches packages from the registry, bundles them with esbuild, and loads the result into the isolate. The agent writes code with import statements, and it just works:

```javascript
import { parse } from "csv-parse/sync";
import { z } from "zod";

const csv = await tools.read({ path: "/data/sales.csv" });
const rows = parse(csv, { columns: true });

const SaleSchema = z.object({
  date: z.string(),
  amount: z.coerce.number(),
  region: z.string()
});

const validated = rows.map((row) => SaleSchema.parse(row));
const totalByRegion = {};
for (const sale of validated) {
  totalByRegion[sale.region] = (totalByRegion[sale.region] || 0) + sale.amount;
}
return totalByRegion;
```

Parse a CSV with a real parser. Validate with Zod. Aggregate results. All in a sandboxed isolate with no network access. The npm registry is available at build time; the resulting code runs in a locked-down environment.

### Tier 3 — Browser Rendering

When the task requires the web — research, scraping, form filling, screenshot capture — the agent gets a headless Chromium instance via Cloudflare Browser Rendering. Navigate, click, extract, screenshot. The agent sees the web the way a user does.

### Tier 4 — Sandboxes

For tasks that truly need a real operating system — `git clone`, `npm test`, `cargo build`, running a Python script — the agent shells out to a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). A lightweight, secure execution environment with pre-installed toolchains, synced bidirectionally with the Workspace. Files edited in the Workspace appear in the sandbox and vice versa.

### Escalation, not configuration

The key design principle: **the agent should be useful at Tier 0 alone.** Each additional tier is additive. An agent without sandbox bindings still works — it just can't run `gcc`. An agent without browser bindings still works — it just can't scrape web pages. You add capabilities as you need them, and the agent escalates automatically based on the task.

```typescript
class FullAgent extends AssistantAgent<Env> {
  workspace = new Workspace(this, { r2: this.env.R2 });

  getTools() {
    return {
      ...createWorkspaceTools(this.workspace), // Tier 0
      ...createExecuteTool({ loader: this.env.LOADER }), // Tier 1-2
      ...createBrowserTools(this.env.BROWSER), // Tier 3
      ...createSandboxTools(this.env.SANDBOX) // Tier 4
    };
  }
}
```

No other platform offers this spectrum. Most agent frameworks give you "call a function" or "run in Docker." Project Think gives you five tiers of compute, from a virtual filesystem to a full sandboxed OS environment, all connected through a single agent that persists across hibernation cycles.

## Agents that survive

Here's a problem nobody talks about in agent framework demos: what happens when your infrastructure disappears mid-thought?

Durable Objects get evicted. The runtime restarts for code updates. An LLM call takes 30 seconds; a multi-turn agent loop takes 30 minutes. At any point during that window, the execution environment can vanish. The upstream connection to OpenAI is severed permanently — you cannot resume an Anthropic stream mid-generation. In-memory state is gone. Connected clients see the stream stop with no explanation.

Every agent framework ignores this. Project Think solves it.

### Fibers: durable execution

A **fiber** is a method invocation that is:

- Registered in SQLite before execution begins
- Kept alive via alarm heartbeats during execution
- Checkpointable — the method can save progress at any point
- Recoverable — if the environment is evicted, the fiber is detected and recovered on restart

```typescript
class ResearchAgent extends AssistantAgent<Env> {
  async startResearch(topic: string) {
    // Fire-and-forget: the fiber survives eviction
    const fiberId = this.spawnFiber("doResearch", { topic });
    this.broadcast({ type: "research_started", fiberId });
  }

  async doResearch(payload: { topic: string }) {
    const messages = [];

    for (let turn = 0; turn < 20; turn++) {
      const result = await generateText({
        model: openai("gpt-4o"),
        messages
      });

      messages.push(
        { role: "user", content: payload.topic },
        { role: "assistant", content: result.text }
      );

      // Checkpoint: if evicted, we resume from here
      this.stashFiber({ messages, turn, topic: payload.topic });

      // Notify connected clients
      this.broadcast({ type: "progress", turn, text: result.text });
    }

    return { summary: messages.at(-1).content };
  }

  onFiberRecovered(ctx) {
    if (ctx.snapshot) {
      // Resume from the last checkpoint
      console.log(`Recovering at turn ${ctx.snapshot.turn}`);
      this.doResearch(ctx.snapshot);
    } else {
      // No checkpoint — retry from scratch
      this.doResearch(ctx.payload);
    }
  }
}
```

Notice: `spawnFiber()` returns an ID, not a Promise. This is deliberate. The caller might not survive eviction. A Promise-based API would be a lie — it implies "you'll get the result" when the caller may be gone by then. The honest API is event-driven: progress via `broadcast()`, completion via `onFiberComplete`, recovery via `onFiberRecovered`.

The heartbeat alarm fires every 10 seconds. The DO inactivity timeout is ~70-140 seconds. So the agent stays alive indefinitely through alarm chaining — no platform changes required, no special configuration.

For LLM streaming specifically, `AIChatAgent` gets smart defaults: it persists stream chunks to SQLite during generation, detects interrupted streams on restart, and provides partial text for prefill continuation. OpenAI's background mode retrieval, Anthropic's prefill continuation, or plain retry — the framework detects the interruption and gives you the hook. You choose the recovery strategy.

### Session trees

Conversations aren't linear. You try an approach, it doesn't work, you backtrack and try something else. Project Think models conversations as trees, not lists.

Every message has a `parent_id`. Branches are different paths through the tree. The `SessionManager` provides:

- **Multiple named sessions** per agent — create, switch, rename, delete
- **Branching** — explore an alternative without losing the original path
- **Forking** — clone a session at any point
- **Compaction** — when context overflows, summarize older messages rather than truncating them, preserving semantic content
- **Truncation utilities** — automatically trim large tool outputs to prevent context window blowup

All stored in DO SQLite. All surviving hibernation. All queryable.

```typescript
const session = sessions.create("refactoring-attempt-2");
const branchId = sessions.branch(messageId, "try-functional-approach");
const history = sessions.getHistory(sessionId); // walks root to leaf, applies compactions
```

## Structural safety: a different approach to agent security

Here's the part where we take a position.

Most of the industry is focused on making AI agents safe through behavioral controls: careful prompting, RLHF training, output filtering, guardrails. The assumption is that if we make the model smart enough and careful enough, it won't do anything bad.

Project Think takes a different approach: **make it impossible for the agent to do harmful things, regardless of what the LLM decides.**

This is structural safety. The security properties aren't enforced by the model's behavior — they're enforced by the architecture of the system. A misbehaving model can't break them because the boundaries are computational, not conversational.

### Capability-based isolation

Every agent workload runs in a context with no ambient authority. No `fetch()`, no `connect()`, no access to the internet. The agent can only do what it's been explicitly given bindings to do.

This is enforced by the Cloudflare Workers runtime at the V8 isolate level. It's not a policy check that the agent could theoretically circumvent — the global `fetch` function doesn't exist in the isolate's scope.

External access is only possible through **Gatekeepers** — adapter objects that wrap external services with security policies, require human approval for side-effecting actions, and log everything.

### Gatekeepers: security adapters for external services

A Gatekeeper wraps an external API (Google Docs, GitHub, Slack, a database) and enforces a security policy:

- **Reads are free** — the agent can query data without approval
- **Writes require approval** — mutations are proposed, queued, and wait for human review
- **Every action is logged** — full audit trail, revertable after the fact
- **Credentials are never exposed** — the Gatekeeper injects OAuth tokens transparently via `AuthorizedHttpClient` bindings

```typescript
interface Gatekeeper<Session, Action> extends DurableObject {
  describe(): Promise<ResourceDescription>;
  startSession(queue: ApprovalQueue<Action>): Promise<Session>;
  applyAction(action: Action): Promise<void>;
  rejectAction(action: Action): Promise<void>;
  revertAction(action: Action): Promise<void>;
}
```

The approval queue persists in SQLite. It survives hibernation, survives restarts, survives the user closing their browser and coming back a week later. Pending actions wait until they're reviewed.

The fundamental invariant: **an agent never enables a human to do something the human couldn't do directly.** If the agent has access to a document with restricted access, any user who can't access that document is also prevented from interacting with the agent. If the agent can perform actions that some of its "influencers" (people who can write to its inputs) cannot perform directly, those actions get elevated scrutiny.

### Per-resource isolation

Consider an agent that responds to emails. It needs to read each email and compose a reply. The security risk: a malicious email contains a prompt injection that causes the agent to leak information from a different email.

The behavioral approach: "Train the model to resist prompt injection."

The structural approach: **create a separate, isolated copy of the agent for each email.** Each copy only sees the email it's meant to reply to. It necessarily cannot leak data from another email, because that data doesn't exist in its context. The boundary isn't a prompt — it's a V8 isolate.

This is the power of Durable Objects and Facets working together. Spawning an isolated agent per resource is cheap (milliseconds, $0 when idle), and it gives you a security property that no amount of prompt engineering can achieve.

## Sub-agents: a tree, not a monolith

Real-world agent tasks are rarely monolithic. Research requires searching and analyzing. Code review requires reading and critiquing. Customer support requires looking up data and composing responses. Each step benefits from a different context, different tools, and different system prompt.

Project Think introduces **sub-agents** — child Durable Objects spawned via Facets, colocated with the parent, each with their own isolated SQLite and execution context.

```typescript
import { withSubAgents, SubAgent } from "agents/experimental/subagent";

export class ResearchAgent extends SubAgent<Env> {
  async research(query: string): Promise<string> {
    // Has browser tools and web search
    // Own SQLite for caching results
    // Own system prompt focused on research
  }
}

export class ReviewAgent extends SubAgent<Env> {
  async review(diff: string): Promise<ReviewResult> {
    // Has grep/read/diff tools
    // Own SQLite for review history
    // Own system prompt focused on code review
  }
}

const Base = withSubAgents(AssistantAgent);

export class OrchestratorAgent extends Base<Env> {
  async handleTask(task: string) {
    const researcher = await this.subAgent(ResearchAgent, "research");
    const reviewer = await this.subAgent(ReviewAgent, "review");

    // Fan out — real parallel execution
    const [research, review] = await Promise.all([
      researcher.research(task),
      reviewer.review(task)
    ]);

    // Synthesize
    return this.synthesize(research, review);
  }
}
```

What makes this different from other multi-agent frameworks:

- **Real isolation** — each sub-agent has its own SQLite database. The reviewer can't access the researcher's cache. This isn't a convention — it's enforced by the runtime.
- **Lifecycle control** — the parent can `abortSubAgent("research")` to cancel a runaway child. It can `deleteSubAgent("research")` to wipe its storage entirely.
- **Same-machine locality** — facets are colocated. No network hop for coordination. The latency of a sub-agent RPC is a function call, not an HTTP request.
- **Typed RPC** — `SubAgentStub<ResearchAgent>` exposes all user-defined public methods as async calls. TypeScript catches misuse at compile time.

Sub-agents compose with every other feature. A sub-agent can have its own Workspace. It can spawn its own Dynamic Isolates. It can have its own Fibers for durable execution. The parent doesn't need to know about any of this — it just calls `researcher.research(query)` and gets a result.

### The Loopback pattern

When Dynamic Isolates (from the Worker Loader) need to call back to a sub-agent, they can't hold a sub-agent stub directly — they can only have `ServiceStub` bindings. The pattern:

1. Create a `WorkerEntrypoint` that proxies to the parent Agent
2. The parent delegates to the sub-agent
3. Pass the WorkerEntrypoint as a binding to the dynamic isolate

```
Dynamic Isolate → WorkerEntrypoint → Parent Agent → Sub-agent
```

Three layers of isolation. The dynamic isolate (running LLM-generated code) can only reach the sub-agent (which holds the data) through a proxy (which enforces the security policy). At no point does untrusted code get direct access to storage.

## Extensions: agents that grow

A general-purpose agent needs domain-specific capability. But shipping every possible integration in the framework is impractical. Project Think solves this with extensions — sandboxed Workers that the agent (or the user) can load on demand.

### Skills: lightweight instructions

Inspired by [OpenClaw](https://github.com/openclaw)'s pattern, skills are Markdown files that teach the agent how to do something. The agent sees a compact directory of available skills (name + one-line description). When a task is relevant to a skill, the agent loads the full text into context.

This keeps the base system prompt lean. An agent with 200 skills doesn't have 200 pages of instructions in every request — it has a compact list, and loads the 2-3 it needs for the current task.

### Extensions: sandboxed Workers

For capabilities that require code — API integrations, custom parsers, data connectors — extensions are JavaScript programs that run in Dynamic Isolates.

An extension declares what it needs:

```json
{
  "name": "github",
  "description": "GitHub integration — PRs, issues, repos",
  "tools": ["create_pr", "list_issues", "review_pr"],
  "permissions": {
    "network": ["api.github.com"],
    "workspace": "read-write"
  }
}
```

The extension runs with `globalOutbound: null` by default — no network access unless explicitly declared. The permission model is enforced by binding configuration at the isolate level: an extension that doesn't declare network access has the `fetch` function wired to a binding that blocks all requests.

### Self-authoring extensions

Here's where it gets interesting. The agent can write its own extensions.

"I need to integrate with the Notion API to track project status."

The agent:

1. Writes a TypeScript extension with tool definitions
2. The framework bundles it (optionally with npm deps via workers-builder)
3. Loads it into a Dynamic Isolate
4. Registers the new tools in its own tool set

The next time the user asks about project status, the agent has a `notion_query` tool that didn't exist 5 minutes ago. The extension persists in DO storage and survives hibernation. It's available in every future conversation.

This is the self-improvement loop that makes agents useful over time. Not through fine-tuning or RLHF, but through code. The agent literally writes new capabilities for itself, in sandboxed, auditable, revocable TypeScript.

## The Agentic Loop

At the center of everything is the loop: assemble context, call the model, execute tools, persist results, repeat.

```typescript
class MyAgent extends AssistantAgent<Env> {
  workspace = new Workspace(this, { r2: this.env.R2 });
  sessions = new SessionManager(this);

  getModel() {
    return anthropic("claude-sonnet-4-20250514");
  }

  getSystemPrompt() {
    return "You are a research assistant with access to a persistent workspace.";
  }

  getTools() {
    return {
      ...createWorkspaceTools(this.workspace),
      ...createExecuteTool({ loader: this.env.LOADER })
    };
  }

  getMaxSteps() {
    return 25;
  }
}
```

That's the complete implementation of a persistent, hibernatable, tool-using AI agent with a durable filesystem, sandboxed code execution, conversation branching, and context compaction. Deploy it with `npx wrangler deploy`.

Under the hood, `AssistantAgent` handles:

- **Context assembly** — base instructions + tool descriptions + project context + skills + memory + conversation history + runtime info. The quality of context assembly is the single biggest determinant of agent quality, so we've built it as a layered, overridable system.
- **Multi-step tool execution** — when the model returns tool calls, execute them (with output truncation to prevent context blowup), append results, and loop. Configurable step limits prevent runaway loops.
- **Streaming** — partial text responses stream over WebSocket as they arrive. Tool execution progress (which tool, partial output) streams too.
- **Cancellation** — abort a running turn via AbortSignal. Clean up in-progress tool executions.
- **Persistence** — every message persisted to the SessionManager after each turn. History survives hibernation.
- **Wire compatibility** — speaks the same WebSocket protocol as `@cloudflare/ai-chat`, so existing UI components work out of the box.

## The economics of thinking

Let's talk about money.

A coding agent running on a VPS costs $50-200/month. It runs 24/7, whether you're using it or not. If you want one for every member of your team, multiply accordingly.

A Project Think agent costs:

- **$0 when idle.** Durable Objects hibernate after inactivity. Your agent sleeps and pays nothing. It wakes up in milliseconds when a message arrives or an alarm fires.
- **Fractions of a cent per request.** Durable Object compute is billed per millisecond of wall-clock time. A typical agent turn — context assembly, model call, tool execution — costs less than a cent in compute (the LLM inference is the real cost, and that's the same whether you run locally or on Workers).
- **No infrastructure overhead.** No Docker. No Kubernetes. No SSH keys. No dependency management. No capacity planning. `npx wrangler deploy` and you're live.

This changes the economics of AI agents fundamentally. Instead of "one expensive agent per power user," you can build "one agent per customer" or "one agent per task" or "one agent per email thread." The marginal cost of spawning a new agent is effectively zero.

## What you can build today

Project Think is available as a preview. Here's what's working:

**A personal coding agent** — persistent Workspace, session branching, file tools (read, write, edit, find, grep, list, delete), code execution in Dynamic Isolates, conversation compaction, and streaming. The full coding agent experience, deployed as a Durable Object.

**A customer support agent** — sub-agents per ticket for isolation, approval queues for actions that modify customer data, Gatekeeper-based access to external APIs, full audit trail.

**A research agent** — browser tools for web research, code execution for data analysis, persistent memory across sessions, durable Fibers that survive infrastructure restarts.

**AI Gadgets** — vibe-coded personal applications where an AI agent writes the application code (a Durable Object), the UI code (sandboxed iframe), and connects to external services through Gatekeepers with human-in-the-loop approval. Think of it as Google Docs meets Replit meets an AI assistant — each Gadget is a tiny, sandboxed application that the user builds through conversation.

## Getting started

```bash
npm create cloudflare@latest -- --template agents-starter
```

The starter template includes an `AssistantAgent` with Workspace tools, session management, and a React-based chat UI. From there, add execution tiers, sub-agents, extensions, and Gatekeepers as your use case demands.

```typescript
// src/server.ts
import {
  AssistantAgent,
  Workspace,
  createWorkspaceTools,
  createExecuteTool
} from "agents/experimental/assistant";

export class MyAgent extends AssistantAgent<Env> {
  workspace = new Workspace(this, { r2: this.env.R2 });

  getModel() {
    return anthropic("claude-sonnet-4-20250514");
  }

  getSystemPrompt() {
    return `You are a helpful assistant with access to a persistent workspace
and the ability to execute code. Use your tools to help the user.`;
  }

  getTools() {
    return {
      ...createWorkspaceTools(this.workspace),
      ...createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        loader: this.env.LOADER
      })
    };
  }
}
```

```typescript
// src/client.tsx
import { useAgent } from "agents/react";

function App() {
  const agent = useAgent({ agent: "my-agent", name: "default" });
  // Use with @cloudflare/ai-chat UI components
}
```

## The third wave

We see three waves of AI agents:

**The first wave was chatbots.** Stateless, reactive, fragile. Every conversation started from scratch. The model had no tools, no memory, no ability to take action. Useful for answering questions. Limited to answering questions.

**The second wave was coding agents.** Stateful, tool-using, capable. Pi, Claude Code, OpenClaw, Codex — agents that could read codebases, write code, execute it, and iterate. These proved that an LLM with the right tools is a general-purpose machine. But they ran on your laptop, for one user, with no durability guarantees.

**The third wave is agents as infrastructure.** Durable, distributed, structurally safe, serverless. Agents that run on the internet, survive failures, cost nothing when idle, and enforce security through architecture rather than behavior. Agents that any developer can build and deploy for any number of users.

Project Think is our bet on the third wave. The Agents SDK already powers thousands of agents in production. With Project Think, we're adding the ideas and infrastructure to make those agents dramatically more capable — persistent workspaces, sandboxed execution, durable long-running tasks, structural security, sub-agent coordination, and self-authored extensions.

It's available as a preview today. We'd love to see what you build.

---

_Project Think is part of the Cloudflare Agents SDK. The features described in this post are in preview and available under the `agents/experimental/` import path. APIs may change as we incorporate feedback. Check the [documentation](https://developers.cloudflare.com/agents) and [examples](https://github.com/cloudflare/agents/tree/main/examples) to get started._
