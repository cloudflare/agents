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
  repo = "https://github.com/org/repo"; // a *default* — usually resolved per-instance, see §8
  workDir = "/workspace/repo";
  gateway = "default"; // AI Gateway id for tokenless egress
  sleepAfter = "15m";
}
```

Surface (initial):

- **Config:** `repo`, `workDir`, `gateway`, `sleepAfter`, `cliArgs`,
  `permissionPolicy` — resolved per-instance, not hardcoded (§8).
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

> This snapshot approach may be **superseded** by a durable-VFS filesystem
> backend (§9), where state lives in the DO and the snapshot dance disappears.
> Both sit behind the same filesystem seam, so v1 can ship snapshots and swap
> later without an API change.

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

### 8. Configuration & topology

**Dynamic config (resolve, don't hardcode).** The class-field form is the simple
case; the common case is one repo _per instance / per thread_. Config resolves
by precedence and is **frozen on the first turn** — the workspace is built around
the repo, so changing it mid-session means a new thread, not a re-clone:

```
configure() (persisted in DO storage)  >  this.props (sub-agent Props)  >  class-field default
```

A threaded/delegated coder gets its repo at spawn — `subAgent(MyCoder, id, { repo, branch })`
— and a standalone one via a `@callable() configure({ repo })` on first connect.
`repo` is the minimum; `branch`, `baseRef`, and per-session env follow the same
path.

**Topology.** Because `CodingAgent` is a clean `Think` subclass, three shapes
fall out of existing primitives with no new machinery:

1. **Standalone** — one DO, one repo.
2. **Threads (a userland directory pattern, not a shipped class).** A plain
   `Agent` owns a table of sessions with **domain-specific** metadata and spawns
   one `CodingAgent` child per session:

   ```ts
   // userland — your rows, your columns
   class CodingSessions extends Agent<Env> {
     // sessions(id, repo, branch, status, lastDiff, updatedAt) — your schema
     @callable() async create(repo: string) {
       /* insert row + subAgent(MyCoder, id, { repo }) */
     }
     @callable() async list() {
       /* your shape */
     }
   }
   ```

   This gives the Codex-cloud / background-agents product shape (session
   dashboard, per-thread isolated containers, cross-session shared memory via
   `RemoteContextProvider`) **without** a first-class `Chats` base class. We
   deliberately do _not_ ship a generic directory: a coding directory's metadata
   (`repo`/`branch`/`status`/`lastDiff`) is domain-specific and outgrows any
   fixed `ChatSummary` schema immediately. What stays shipped are the
   load-bearing primitives this leans on — `subAgent` + Props, `parentAgent()`,
   and `RemoteContextProvider`/`RemoteSearchProvider` — plus a reference example.
   (See the note added to [`rfc-think-multi-session.md`](./rfc-think-multi-session.md).)

3. **Orchestrated** — delegated via `codingAgentTool`, incl. `delegate_parallel`
   fan-out (the example's pattern).

Requirement this places on the design: **nothing in `CodingAgent` may assume a
top-level binding** — it must work as a userland directory child and as an
agent-tool facet.

### 9. Two more seams, designed in from day one

v1 implements only the container-backed versions, but both are interfaces so we
don't get boxed in.

**Filesystem backend.** Today: clone into the Sandbox + snapshot for durability
(§5). Abstract file access behind a backend interface so the durable VFS in
[`cloudflare/workspace`](https://github.com/cloudflare/workspace) can slot in
later — it holds authoritative state in the DO (SQLite) and projects it into the
container as a FUSE mount, with a cheap Worker (`just-bash`) backend for textual
tooling alongside the container backend. If it pans out it **supersedes the
snapshot durability plan** (state lives in the DO, not the disk) and unifies the
cheap-grep / heavy-`npm` tool split. It is **preview-only / unstable** today with
a real large-file I/O penalty (metadata ops are competitive-to-faster), so:
spike it as an alternate backend, do **not** couple v1 to it.

**Run / preview.** A coding agent that builds web apps must _run_ them. Two
models, chosen by target:

- container dev server (`vite dev` + Sandbox `exposePort`) — any stack, real HMR,
  native deps; long-lived process + public URL;
- Worker-native (`@cloudflare/worker-bundler` `createApp` → `env.LOADER`, assets
  served host-side) — instant, scales to zero, durable, **but Workers-target only**.

`CodingAgent.preview()` picks: a Workers-compatible project → `LOADER`
(cheap/instant/durable); else → container dev server. The Worker-native path is
also the _run_ primitive for the native runtime (§10).

### 10. Future work: a Workers-native coding runtime (Runtime B)

The `TurnRuntime` seam (§1) makes "our own coding agent" just a _second_ runtime
behind the same `CodingAgent` shell: a model-driven Think loop with coding tools
(read/edit/grep/bash) where the model is Workers AI / AI Gateway and the tools
run in the Workspace — **no container** for the textual-edit case, escalating to
a container only for `npm`/build (§9) and previewing via `env.LOADER` (§9). Same
class, same threads, same UI. `delegate_parallel` could then race the CLI runtime
against the native one on one task — an instant eval/dogfooding harness. Deferred
to its own RFC; captured here so v1's seams don't preclude it.

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

- **Adopt `cloudflare/workspace` as the filesystem now.** Tempting — durability
  becomes structural (state in the DO, not the disk) and the tool split unifies.
  But it's preview-only / unstable with a large-file I/O penalty; coupling a
  shipped class to it inherits that risk. Designed behind a backend seam (§9) and
  spiked separately instead.

- **Keep it an example, not a package class.** Status quo. Re-pays the full
  integration cost per use and leaves the durability/recovery gaps unsolved.

## The decision

_Pending review._ Open questions to settle here:

1. Confirm Think-subclass + internal `TurnRuntime` seam over the AIChatAgent route.
2. `@cloudflare/sandbox` as a peer dep of the `coding` subpath — acceptable?
3. Class name across subpaths: shared `CodingAgent` (engine swap by import) vs
   per-CLI names (`ClaudeCodeAgent`, `CodexAgent`).
4. Config precedence + **freeze-on-first-turn** semantics (§8) — confirm repo is
   immutable after turn 1.
5. Put the filesystem behind a backend interface in v1 (container impl only) so a
   `cloudflare/workspace` backend can land later without an API change (§9)?
6. Is `preview()` (LOADER vs container dev server, §9) in v1 scope or a follow-up?
7. Scope of the first PR: seam + claude-code adapter + userland-directory topology +
   rewrite the example to use the class (delete its local mapper). Codex,
   `preview()`, and the workspace-VFS spike deferred.

## History

- `examples/sandbox-coding-agent` (PR #1830) — the prototype this promotes.
- cloudflare/agents#1829 — `@ai-sdk/sandbox-cloudflare` provider (future engine).
