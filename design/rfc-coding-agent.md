Status: proposed

# RFC: First-class `CodingAgent` for Think

A Cloudflare-owned agent class that drives a CLI coding agent (Claude Code first,
Codex/others later) inside a Cloudflare Sandbox, slotted in like any other Think
agent:

```ts
import { CodingAgent } from "@cloudflare/think/claudecode";

export class MyCoder extends CodingAgent<Env> {
  repo = "https://github.com/threepointone/aywson";
}
```

Prototyped in `examples/sandbox-coding-agent` (PR #1830). This RFC proposes
promoting that prototype into the `@cloudflare/think` package as a supported
class, and locks the surface before any core code moves.

## The problem

The big coding-agent CLIs (Claude Code, Codex, Gemini CLI, …) are an important,
durable category: a user who wants "Claude Code, but as a stateful agent on my
infra, with a UI, recovery, and orchestration" should get that in a few lines.

Today they can't, cleanly:

- **Think has no turn seam for a non-model runtime.** `Think._runInferenceLoop`
  is hardwired to `streamText({ model: getModel() })` (`packages/think/src/think.ts`).
  A coding CLI is not a `LanguageModel` — it owns its own agentic loop, tools,
  context, and session — so it cannot be returned from `getModel()`.
- **The only escape hatch is `AIChatAgent.onChatMessage`**, which returns an
  arbitrary `Response`. That is what the example uses for its child coding agent,
  which means the child is _not_ a Think agent (can't orchestrate, doesn't share
  Think's hooks/recovery semantics), and we hand-roll the CLI's `stream-json` →
  `UIMessage` translation (`examples/sandbox-coding-agent/src/claude-code.ts`,
  ~375 lines of mapper).
- **Everything Cloudflare-specific is re-implemented per example**: the Sandbox
  lifecycle, the zero-token AI Gateway egress trick, the session `--resume`
  plumbing, the diff capture, and the (currently absent) durability story.

We keep paying this cost every time someone wants a coding agent. The category
is worth owning end-to-end.

## The proposal

Ship `CodingAgent` as a first-class `Think` subclass under per-CLI subpath
exports of `@cloudflare/think`. We own the whole stack, so we can do
Cloudflare-native things a generic wrapper can't (snapshots for durability,
tokenless gateway egress, DO-tuned recovery, HITL via Think approvals).

**Strategic stance: own the public interface, keep the engine swappable.** The
`CodingAgent` API is the durable bet. Whether it drives the CLI directly (now)
or delegates to a matured `@ai-sdk/harness` later is an implementation detail
behind the same class — users never re-learn an API.

### 1. A minimal, internal turn seam in Think

Generalize the single convergence point so a turn can be produced by something
other than `streamText`. This is the _private_ version of a "turn runtime" — not
a public pluggable API; `CodingAgent` is its first and (initially) only consumer.

```ts
// internal to @cloudflare/think
interface TurnRuntime {
  // Must emit the same AI-SDK UI-message stream Think already consumes
  // downstream, so persistence / recovery / agent-tools / UI are unchanged.
  streamTurn(
    ctx: TurnContext,
    opts: { abortSignal: AbortSignal }
  ): Promise<StreamableResult>;
}
```

`_runInferenceLoop` resolves a runtime instead of hardcoding the model:

```ts
const runtime = this._turnRuntime() ?? new ModelTurnRuntime(this.getModel());
const result = await runtime.streamTurn(finalTurnContext, { abortSignal });
// everything below — UI piping, persistence, recovery — is untouched
```

`ModelTurnRuntime` wraps today's `streamText` path verbatim (no behavior change
for existing agents). `CodingAgent` supplies a `CliTurnRuntime`. Because
`HarnessAgent.stream()` (and our CLI mapper) already emit AI-SDK stream parts,
the downstream consumer needs no changes.

### 2. `CodingAgent` (the owned class)

A `Think` subclass that, per turn:

1. ensures a warm Sandbox with the repo present (clone, or restore from snapshot);
2. runs the CLI headless against the latest user message, mapping its event
   stream to `UIMessage` chunks;
3. captures the resulting diff and persists session/continuation state.

`getModel()` is unused on this path. Configuration is declarative:

```ts
export class MyCoder extends CodingAgent<Env> {
  repo = "https://github.com/org/repo"; // or override prepareWorkspace()
  workDir = "/workspace/repo";
  gateway = "default"; // AI Gateway id for tokenless egress
  sleepAfter = "15m";
}
```

Surface (initial):

- **Config props:** `repo`, `workDir`, `gateway`, `sleepAfter`, `cliArgs`,
  `permissionPolicy`.
- **Hooks:** `prepareWorkspace(sandbox)`, `onDiff(diff)`, `beforeToolCall(name,
input)` (reuse Think's existing approval/authorization machinery for HITL),
  `beforeCommit(diff)`.
- **Built-in callables:** `getWorkspaceDiff()`, `getFileTree()`, optional
  `commit()/openPR()` helpers.
- Inherits all of Think: agent-tools (it can orchestrate _and_ be delegated to),
  channels, MCP, persistence, recovery, resumable streams.

Usage forms:

```ts
// 1. subclass (above) — the 90% case
// 2. config factory:
const Coder = createCodingAgent({ cli: "claude-code", repo, gateway: "default" });
// 3. as a delegated sub-agent (Think-on-Think, no @cloudflare/ai-chat child):
getTools() {
  return { delegate: codingAgentTool(MyCoder, { inputSchema: z.object({ task: z.string() }) }) };
}
```

### 3. Per-CLI adapter contract & packaging

Same class name, swap the subpath, swap the engine:

```ts
import { CodingAgent } from "@cloudflare/think/claudecode"; // claude -p
import { CodingAgent } from "@cloudflare/think/codex"; // codex exec
```

Each subpath exports a `CodingAgent` pre-bound to one `CliAdapter`:

```ts
interface CliAdapter {
  name: string; // "claude-code"
  minVersion: string; // asserted against the installed CLI
  buildCommand(turn: {
    prompt: string;
    sessionId?: string;
    args?: string[];
  }): string;
  bootEnv(ctx: { gatewayPlaceholderKey: string }): Record<string, string>;
  // stream-json line → UI-message chunks (the only per-CLI complexity)
  mapLine(line: string, sink: ChunkSink): void;
  // resume / session identity
  sessionFlag(sessionId: string | undefined): {
    flag: string;
    sessionId: string;
  };
  detectFailure(state: AdapterState): string | undefined;
}
```

The claude-code adapter is the example's `ClaudeStreamMapper` + command builder,
lifted and hardened. **Per-CLI `stream-json` drift is the real maintenance tax**
(the cost `@ai-sdk/harness` amortizes across the ecosystem); we accept it and
contain it with the conformance suite (§7) and a CLI version pinned in the base
image. **Ship claude-code only first**; add `codex` once the adapter contract is
proven.

Package layout:

```
packages/think/src/coding/
  index.ts           # CodingAgent base + createCodingAgent + codingAgentTool
  runtime.ts         # CliTurnRuntime (TurnRuntime impl)
  sandbox.ts         # Sandbox subclass: AI Gateway egress + backup/restore
  adapters/
    claude-code.ts   # CliAdapter (mapper lifted from the example)
exports: "@cloudflare/think/claudecode" -> a CodingAgent bound to the claude adapter
```

`@cloudflare/sandbox` becomes a (peer?) dependency of the coding subpath only —
not of the think core. (New `packages/` dependency → needs sign-off per
`AGENTS.md`.)

### 4. Tokenless egress, built in

The `outboundByHost` + `env.AI.gateway()` interception from the example moves
into `coding/sandbox.ts`, so every `CodingAgent` is zero-secret by default —
no Anthropic key, no `cf-aig` token in the container, only a plaintext gateway
id. This stops being per-example boilerplate.

### 5. Durability via Sandbox snapshots

Resolves the gap documented in the example README. The container disk is
ephemeral; `CodingAgent` makes the DO the source of truth:

- on turn finish: `sandbox.createBackup({ directory })` of `workDir` **and**
  `~/.claude` (session data), store the `DirectoryBackup` handle in DO storage
  next to the session id;
- in `prepareWorkspace`: restore if a backup exists, else clone.

The disk becomes a cache; multi-turn survives container sleep (real `--resume`
against restored session data, edits accumulate).

### 6. Recovery tuned to the DO lifecycle

Because we own the CLI invocation we own the checkpoint, rather than depending on
a harness primitive:

- **Between turns (reliable):** persisted session id + workspace snapshot →
  resume on wake.
- **Mid-turn eviction (best-effort):** persist a continuation marker; on wake,
  prefer resume-the-same-turn over re-issue when the CLI supports it. Honest
  caveat: abrupt eviction may not allow a clean checkpoint — still strictly
  better than today's "orphan the process + restart."

### 7. Conformance tests (the drift guard)

One golden-transcript suite per CLI adapter: a recorded `stream-json` fixture →
assert the exact `UIMessage` chunk sequence. Pin the CLI version in the base
image; bumping it must update the fixture. This is how we keep the maintenance
tax bounded and visible.

## The alternatives

- **Wrap `@ai-sdk/harness` `HarnessAgent` behind a public `TurnRuntime` API**
  (the prior proposal). Rejected as the _primary_ bet: it's experimental,
  version-locked to the AI SDK major, and has no Cloudflare sandbox provider, so
  we'd be building a provider _and_ a wrapper while ceding control of the surface.
  Not discarded — it's the candidate _future engine_ behind `CodingAgent`'s API,
  and writing `@ai-sdk/sandbox-cloudflare` remains tracked separately
  (cloudflare/agents#1829).

- **Build `CodingAgent` on `AIChatAgent` instead of Think.** Quicker (the
  `onChatMessage` seam already exists), but caps it at a leaf coding agent: it
  can't orchestrate or delegate, and it diverges from Think's hook/recovery
  model. We want coder and orchestrator to be the same base.

- **Expose a public, pluggable turn-runtime API now.** Premature: one consumer.
  Keep the seam internal until a second runtime justifies a stable contract.

- **Keep it an example, not a package class.** Status quo. Re-pays the full
  integration cost per use and leaves the durability/recovery gaps unsolved.

## The decision

_Pending review._ Open questions to settle here:

1. Confirm Think-subclass + internal `TurnRuntime` seam over the AIChatAgent route.
2. `@cloudflare/sandbox` as a peer dep of the `coding` subpath — acceptable?
3. Class name across subpaths: shared `CodingAgent` (engine swap by import) vs
   per-CLI names (`ClaudeCodeAgent`, `CodexAgent`).
4. Scope of the first PR: seam + claude-code adapter + rewrite the example to use
   the class (delete its local mapper), with codex deferred.

## History

- `examples/sandbox-coding-agent` (PR #1830) — the prototype this promotes.
- cloudflare/agents#1829 — `@ai-sdk/sandbox-cloudflare` provider (future engine).
