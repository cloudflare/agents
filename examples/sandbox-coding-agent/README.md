# Sandbox Coding Agent

A [Think](../../packages/think) agent that acts as an **orchestrator over coding agents running in containers**. You chat with the orchestrator; it delegates each concrete coding task to a [Claude Code](https://code.claude.com/docs/) sub-agent running in its own [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container, and streams each sub-agent's work — narration, tool calls, and the final git diff — back into the chat.

This is the Cloudflare-native take on the ["agent harness"](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) pattern, one level up: instead of being _a_ coding agent, Think is the **layer that orchestrates** them. Each delegated task is an isolated, durable sub-agent with its own container.

## What it demonstrates

- **Agents as tools / sub-agents.** The orchestrator exposes `agentTool(ClaudeCodeAgent, …)` so its planning loop can delegate work. When it does, the framework spawns the sub-agent as a _facet_, forwards its chat chunks to the parent as `agent-tool-event` frames, and surfaces its `reportProgress` on a live bar — all on the same WebSocket.
- **One container per task.** A sub-agent runs as a facet whose `this.name` is the agent-tool **run id** (`agent-tool:<toolCallId>`); we hash it to a DNS-safe `sandboxIdFor(this.name)` so `getSandbox(env.Sandbox, …)` gives every delegated task its _own_ isolated container with the repo checked out.
- **Parallel fan-out.** `delegate_parallel` dispatches several tasks at once (or competing attempts at one task) via `runAgentTool`, each in its own container, then compares the diffs.
- **Think owns the planning loop; Claude Code owns the coding loop.** The orchestrator's loop runs on Workers AI; each sub-agent drives the Claude Code CLI headless inside its container and maps its `stream-json` output into AI SDK `UIMessage` chunks.
- **No tokens, no secrets.** The container has zero credentials. The Sandbox intercepts Claude Code's egress to `api.anthropic.com` and forwards it through the `env.AI.gateway()` binding, which authenticates via your Cloudflare account. The only config is a plaintext gateway id.

The demo repo is [`threepointone/aywson`](https://github.com/threepointone/aywson), a small JSONC parser with tests.

## Prerequisites

- **Docker** running locally — `@cloudflare/sandbox` runs the container via Docker for local dev. Deploying Containers requires a **paid Workers plan**.
- A Cloudflare **AI Gateway** that can reach Anthropic without a per-request key — i.e. [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) enabled, or an Anthropic key stored in the gateway (BYOK). No tokens live in this repo.

## Run it

```bash
pnpm install
pnpm run start
```

Set `GATEWAY_ID` in `wrangler.jsonc` to your gateway's name (defaults to `"default"`). Then open the dev server and ask the orchestrator to delegate work, e.g.:

> Add a `clone(json)` helper that deep-copies a JSONC string while preserving comments, with a test.

Or fan out in parallel:

> Do two things in parallel: (1) add a `clone()` helper with a test, and (2) add JSDoc to the public exports.

## How auth works (the "no token" trick)

Claude Code expects to talk to `https://api.anthropic.com`. Rather than baking an Anthropic key (or an AI Gateway token) into the container, the `Sandbox` subclass **intercepts that egress** and forwards it through the AI Gateway binding:

```ts
// src/server.ts
export class Sandbox extends BaseSandbox<Env> {
  constructor(ctx, env) {
    super(ctx, env);
    this.interceptHttps = true; // Anthropic is HTTPS
    this.enableInternet = true; // let the github.com clone pass through
  }
}

// Register via the inherited setter (a `static` field would shadow it).
Sandbox.outboundByHost = {
  "api.anthropic.com": async (req, env) => {
    const endpoint = new URL(req.url).pathname.replace(/^\/+/, ""); // "v1/messages"
    return env.AI.gateway(env.GATEWAY_ID).run({
      provider: "anthropic",
      endpoint,
      headers: { "content-type": "application/json" /* + anthropic-version */ },
      query: await req.json()
    });
  }
};
```

Because `env.AI.gateway()` is authenticated by the Worker's account, there is **no `cf-aig` token and no Anthropic key in the container** — billing is handled by the gateway (Unified Billing or a stored key). The CLI still requires _some_ key to boot, so we pass a throwaway `ANTHROPIC_API_KEY=cf-aig-placeholder` that is dropped at the interception boundary.

> Outbound interception requires exporting the SDK's `ContainerProxy` from the Worker entry (`ctx.exports.ContainerProxy`) — see `src/server.ts`.

## How it fits together

```
Browser (useAgentChat + useAgentToolEvents)
        │  WebSocket: orchestrator stream + forwarded agent-tool-event frames
        ▼
CodingOrchestrator (Think, Durable Object)  ── planning loop on Workers AI
        │  getTools(): delegate_coding_task = agentTool(ClaudeCodeAgent, …)
        │              delegate_parallel    = runAgentTool fan-out
        ▼
ClaudeCodeAgent (AIChatAgent facet, name = runId)   ── one per delegated task
        │  getSandbox(env.Sandbox, sandboxIdFor(this.name))
        ▼
Sandbox container (@cloudflare/sandbox) — `claude -p` against the aywson checkout
        │  egress to api.anthropic.com is intercepted →
        │    env.AI.gateway(GATEWAY_ID).run({ provider: "anthropic", … })
        ↑  reportProgress + streamed chunks + final diff  ──▶ orchestrator UI
```

The orchestrator delegates (`src/server.ts`):

```ts
getTools(): ToolSet {
  return {
    delegate_coding_task: agentTool(ClaudeCodeAgent, {
      displayName: "Claude Code",
      inputSchema: z.object({ task: z.string().min(5) })
    }),
    delegate_parallel: tool({ /* runAgentTool fan-out across containers */ })
  };
}
```

The sub-agent runs Claude in its own container and reports the diff (`src/server.ts` + `src/claude-code.ts`):

```ts
export class ClaudeCodeAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish, options) {
    const sandbox = getSandbox(this.env.Sandbox, sandboxIdFor(this.name), {
      sleepAfter: "15m"
    });
    await this.ensureWorkspace(sandbox);
    return runClaudeCode({
      sandbox,
      workDir,
      prompt: latestUserText(this.messages),
      reportProgress: (p) => void this.reportProgress(p),
      onResult: (result) => {
        this.lastResult = result;
      }
      /* … */
    });
  }
  // What the orchestrator sees — a compact summary, not the whole diff.
  protected getAgentToolOutput() {
    /* files changed from this.lastResult */
  }
}
```

## Durability & recovery

This example has **three independent durable lifecycles**, each with its own eviction/sleep clock. The recovery story falls out of how (un)aligned they are:

```
CodingOrchestrator (Think DO)        chat + planning loop      ← SQLite-backed
  └─ ClaudeCodeAgent (facet DO)      one per delegated task    ← SQLite-backed
       └─ Sandbox (container DO)     claude -p + the checkout  ← disk is EPHEMERAL
```

The two Durable Objects are SQLite-backed and recover well. The container is the weak link: its filesystem does not survive a sleep.

| Event                                    | DO state (SQLite)                                 | In-flight stream                          | Container disk                     |
| ---------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| Client disconnect (tab close, nav)       | kept                                              | buffered in SQLite, replayed on reconnect | untouched                          |
| DO hibernation (idle)                    | persisted; `onStart` rehydrates `claudeSessionId` | n/a                                       | warm if within `sleepAfter`        |
| DO eviction mid-turn (deploy/restart)    | `chatRecovery` recovers the turn                  | tail lost; turn re-issued                 | keeps running (orphaned)           |
| Container sleep (`sleepAfter`, 15m idle) | unaffected                                        | n/a                                       | **gone** — fresh disk on next wake |

- **Hibernation is fine.** Both agents use the WebSocket Hibernation API and set `chatRecovery = true`. We persist Claude's session id in `onStart`, and the last diff (`lastResult`) lives on the facet DO, so between-turn state is durable.
- **Mid-turn eviction is only partially recovered.** The sub-agent's "model call" is `runClaudeCode` — a loop reading `sandbox.streamProcessLogs(...)`. If the facet DO is evicted mid-turn, the `claude -p` process keeps running **orphaned** in the container and the tail of that turn is lost; recovery re-enters `onChatMessage` and starts a _new_ `claude -p --resume` rather than re-attaching to the live process (the framework's "child runtime is not live-tailable" case). Hence **resume is between turns, not mid-turn.**
- **The container disk is ephemeral — the real gap.** After `sleepAfter` (15m idle) the container stops and Cloudflare Containers cold-start a clean filesystem from the image. Two things live only on that disk:
  1. the repo + Claude's edits — `ensureWorkspace` papers over the repo with an idempotent re-clone, but **uncommitted edits from prior turns are lost**;
  2. Claude's native session (`~/.claude/…`) — we persist the session _id_ and pass `--resume`, but the session _data_ was on the disk, so after a sleep `--resume` points at a session the fresh container has never seen.

  Net: **within the 15-min warm window multi-turn works** (real `--resume`, edits accumulate); **across a sleep the session silently resets** to a clean checkout. Fine for the single-shot-style demo, a correctness gap for long-lived multi-turn coding.

### Upgrade path (deferred — revisit later)

- **Persist the workspace with backup/restore.** `@cloudflare/sandbox` exposes `sandbox.createBackup({ directory })` → a serializable `DirectoryBackup` (squashfs in R2) and `sandbox.restoreBackup(backup)`. Clean design: on each turn finish back up `WORK_DIR` **and** `~/.claude`, store the handles in DO storage next to `claudeSessionId`, and make `ensureWorkspace` "restore if a backup exists, else clone" — turning the container disk into a cache and the DO into the source of truth. Deferred here to keep the example zero-config (it adds an R2 bucket binding).
- **True mid-turn continuity** needs suspending/resuming an _active_ turn across a process boundary — exactly the AI SDK Harness `session.suspendTurn()` / `detach()` model. Folded into the harness-migration work: see [cloudflare/agents#1829](https://github.com/cloudflare/agents/issues/1829).

## Notes & limitations

- **Orchestrator only delegates.** Think ships built-in workspace tools (`read`/`list`/`find`/…) bound to its _own_ (empty) filesystem; `beforeTurn()` restricts `activeTools` to the two delegation tools so the planner can't wander into a non-existent local repo.
- **Diffs render inline.** Each sub-agent appends its `git diff` to the message it streams, so the diff shows in that delegate's panel. The compact `getAgentToolOutput` (files changed) is what the orchestrator model reasons over, to keep its context small.
- **Claude Code runs as root.** The Sandbox container is root, where the CLI refuses `--permission-mode bypassPermissions` unless it knows it's sandboxed — so the runtime sets `IS_SANDBOX=1`. If a turn ends with no output, the runtime surfaces the CLI's stderr / exit code in the delegate panel instead of silently showing "no changes".
- **HTTPS egress interception.** Routing `https://api.anthropic.com` through the binding relies on the container platform terminating TLS for that host (`interceptHttps`); this works under local Docker. If it ever doesn't fire in your environment, fall back to setting `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` on the container directly (pointing at an AI Gateway URL).
- **Concurrency** is bounded by `maxConcurrentAgentTools` (orchestrator) and the container `max_instances` (wrangler).

## Related examples

- [`agents-as-tools`](../agents-as-tools) — the sub-agent / `agentTool` machinery this builds on, without containers.
- [`ai-chat`](../ai-chat) — `AIChatAgent` + tools + approval.
- [`codemode`](../codemode) — running model-authored code in a Worker-loader sandbox.
