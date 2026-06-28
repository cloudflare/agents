Status: proposed

# RFC: `CodingAgent` — a new `@cloudflare/coding-agent` package

A Cloudflare-owned class that drives a coding agent (Claude Code first,
Codex/others later) inside a Cloudflare Sandbox, with a chat UI, durable
sessions, recovery, and orchestration-friendliness:

```ts
import { CodingAgent } from "@cloudflare/coding-agent/claude-code";

export class MyCoder extends CodingAgent<Env> {
  repo = "https://github.com/threepointone/aywson"; // a default — usually resolved per-instance
}
```

Prototyped in `examples/sandbox-coding-agent` (PR #1830). This RFC proposes
extracting and hardening that prototype into a **new package** — _not_ a Think
subclass and _not_ a Think subpath — and locks the surface before code moves.

> **What changed from the first draft of this RFC.** The original plan made
> `CodingAgent` a `Think` subclass behind a new internal "turn runtime" seam in
> Think core. Review killed that: a coding agent is not a chat-model agent, so
> ~half of Think's surface (`getModel`, `getTools`, `beforeTurn`, compaction,
> context blocks, structured output…) would be inert, the core refactor was the
> riskiest part of the plan, and — crucially — coupling to Think's
> replay-the-transcript model fights reuse of the AI SDK `HarnessAgent`, which
> gives us tested stream-mapping and session lifecycle for free. The conclusion:
> own a small new package with its own opinions and its own dependency schedule.

## The problem

The big coding-agent CLIs (Claude Code, Codex, Gemini CLI, …) are an important,
durable category: someone who wants "Claude Code, but as a stateful agent on my
infra, with a UI, recovery, and orchestration" should get it in a few lines.

Today it's all per-example boilerplate (`examples/sandbox-coding-agent`):

- a hand-rolled ~375-line `stream-json` → `UIMessage` mapper
  (`src/claude-code.ts`) that we maintain ourselves;
- the Sandbox lifecycle, the zero-token AI Gateway egress trick, and the session
  `--resume` plumbing, re-implemented each time;
- **no durability story** — the container disk is ephemeral, so edits and the
  CLI's native session are silently lost across a container sleep (documented as
  a known gap in the example's README).

We re-pay this every time. The category is worth owning end-to-end — in the right
place, with the right base.

## The proposal

Ship **`@cloudflare/coding-agent`**: a new package whose `CodingAgent` extends
`AIChatAgent` (from `@cloudflare/ai-chat`) and drives a coding **engine** inside
a Cloudflare Sandbox.

**Strategic stance: own the public surface; keep the engine pluggable.** The
`CodingAgent` API is the durable bet. The engine that actually drives the CLI is
swappable behind it (see §3).

### 1. Base class: `AIChatAgent`, not `Think`

`CodingAgent extends AIChatAgent`. This gives us, all already tested and shipped:

- `onChatMessage(...)` — returns a UI-message stream `Response`. **This is the
  seam.** No new core machinery, no Think changes.
- chat persistence, resumable streams, and `chatRecovery`;
- `useAgentChat` client integration for the UI;
- works as an **agent-tool child** (the example already delegates to it) — so
  orchestration is "a `Think` (or any agent) delegates to a `CodingAgent` via
  `codingAgentTool`," exactly the shipped example pattern.

Nothing about Think's model loop applies to a coding agent, so we don't inherit
it. (If a `CodingAgent` ever needs to orchestrate sub-agents itself, it uses
`subAgent()` like any `Agent` — it doesn't need to _be_ a `Think`.)

### 2. `CodingAgent` (the owned class)

A thin `AIChatAgent` whose `onChatMessage`, per turn:

1. ensures a warm Sandbox with the repo present (clone / restore — §6);
2. runs the engine against the latest user message, streaming its events as
   `UIMessage` chunks;
3. captures the diff and persists session/continuation state (§6).

```ts
export class MyCoder extends CodingAgent<Env> {
  repo = "https://github.com/org/repo"; // a default — usually resolved per-instance (§7)
  workDir = "/workspace/repo";
  gateway = "default"; // AI Gateway id for tokenless egress (§5)
  sleepAfter = "15m";
}
```

Surface (initial):

- **Config:** `repo`, `workDir`, `gateway`, `sleepAfter`, `cliArgs` — resolved
  per-instance, not hardcoded (§7).
- **Hooks:** `prepareWorkspace(sandbox)`, `onDiff(diff)`.
- **Built-in callables:** `getWorkspaceDiff()`, `getFileTree()`.
- Inherits `AIChatAgent`: chat persistence, resumable streams, recovery,
  agent-tool child behavior.

Usage forms:

```ts
// 1. subclass (above) — the 90% case
// 2. config factory:
const Coder = createCodingAgent({ engine: claudeCode, repo, gateway: "default" });
// 3. delegated from an orchestrator (the example's pattern, unchanged):
getTools() {
  return { delegate: codingAgentTool(MyCoder, { inputSchema: z.object({ task: z.string() }) }) };
}
```

> Deferred out of v1 (see §10): `commit()` / `openPR()` (need git/GitHub creds —
> fights the zero-secret story, needs its own auth design) and per-tool HITL /
> `permissionPolicy` (brokering in-container tool calls for approval is a project
> on its own, not a config flag).

### 3. The engine seam (and why it answers "don't hand-roll the mapper")

`CodingAgent` delegates the turn to a `CodingEngine`. An engine takes the latest
prompt + a durable session handle and emits AI-SDK stream parts. Two concrete
engines, in priority order:

- **`HarnessEngine` (the goal).** Wraps the AI SDK `HarnessAgent`, which is
  itself an AI SDK `Agent`: `createSession()`, `stream({ session, prompt })`
  emitting stream parts, plus `detach()/stop()/suspendTurn()/resumeFrom`. This
  gives us the `stream-json` mapping, session lifecycle, and suspend/resume
  **tested and maintained upstream** — the maintenance tax we'd otherwise own.
  It requires a Cloudflare sandbox provider for harness (tracked as
  cloudflare/agents#1829), which becomes a real workstream, not a footnote.
- **`CliEngine` (ships first).** The example's concrete driver + mapper, lifted
  and hardened. Works **today** with no dependency on harness or the provider.
  It's the fallback for CLIs harness doesn't support and the bootstrap until
  `HarnessEngine` is ready.

We do **not** design a speculative multi-CLI "adapter interface" up front (a
prior draft did; review flagged it as designing an abstraction from a single
example). `CliEngine` ships claude-code concretely; the per-CLI adapter
interface gets _extracted_ only once a second CLI (codex) actually lands and we
can see the real shape.

Independent package ⇒ independent deps: `@cloudflare/coding-agent` can pin
whatever AI-SDK major `@ai-sdk/harness` needs **without gating `@cloudflare/think`
or the rest of the repo.**

### 4. Why a separate package (not a Think subpath)

- **Layering.** A Think subpath would put `@cloudflare/sandbox` into the chat
  agent base. `AGENTS.md` records the opposite preference: _"when a package
  boundary feels wrong (e.g. a helper depending on a larger package just for an
  adapter), prefer moving the adapter out."_ Containers don't belong in Think.
- **Opinions.** A fresh package lets us bake coding-specific opinions (sandbox
  lifecycle, diff capture, egress) without polluting a general base.
- **Deps & release cadence.** Independent versioning and the AI-SDK-major
  freedom above.

Dependencies: `agents`, `@cloudflare/ai-chat`, `@cloudflare/sandbox`, and
(for `HarnessEngine`) `@ai-sdk/harness` + the CF sandbox provider. New
`packages/` deps need sign-off per `AGENTS.md`.

```
packages/coding-agent/src/
  index.ts             # CodingAgent (extends AIChatAgent) + createCodingAgent + codingAgentTool
  sandbox.ts           # Sandbox subclass: AI Gateway egress (+ snapshot helpers, §6)
  engines/
    cli.ts             # CliEngine (concrete; mapper lifted from the example)
    harness.ts         # HarnessEngine (wraps HarnessAgent; gated on #1829)
exports: "@cloudflare/coding-agent/claude-code" -> a CodingAgent bound to the claude engine
```

### 5. Tokenless egress (scoped honestly)

The example's `outboundByHost` + `env.AI.gateway()` interception moves into the
package's Sandbox subclass (and, for `HarnessEngine`, into the CF sandbox
provider). The honest scope:

- it's **per-provider** — `api.anthropic.com`→anthropic, `api.openai.com`→openai,
  etc. — so the egress map is engine/CLI-specific, not a universal switch;
- it relies on the container platform terminating TLS for that host
  (`interceptHttps`); we keep the documented fallback (`ANTHROPIC_BASE_URL` /
  key pointed at a gateway URL) prominent;
- CLIs that authenticate via OAuth / subscription (no rewritable base URL)
  **cannot** be made tokenless this way — call that out rather than implying
  "zero-secret always."

Within those bounds it's a genuine differentiator: for API-key CLIs, the
container holds **no credentials**.

### 6. Durability & recovery — two decoupled lifecycles

The crux, and the thing this package can do _well_ because it owns the whole
stack. There are **two independent lifecycles with different shutdown
behaviors**, and most bugs live in their seams:

|           | Durable Object (control plane)                   | Sandbox container (compute)                      |
| --------- | ------------------------------------------------ | ------------------------------------------------ |
| Shutdown  | hibernation (state kept) / eviction (state kept) | `sleepAfter` sleep, OOM, crash — **disk wiped**  |
| Trigger   | idle, deploy, restart                            | idle timer, platform — **independent of the DO** |
| Authority | source of truth (SQLite)                         | a cache                                          |

They fail **independently**: a DO can be evicted while its container keeps
running orphaned; a container can sleep/crash while the DO is happily
hibernating. So the design is a **reconcile-on-wake** protocol, not a single
checkpoint:

- **Persist authority in the DO**, not the container: the session handle
  (harness `resumeState` / the CLI session id) and a workspace checkpoint.
- **On wake, reconcile:** is the session/container still live (attach) or gone
  (re-create from the persisted state)?

`HarnessEngine` gets most of this for free via session lifecycle:

- idle → `session.detach()` (park, keep sandbox warm) + persist `resumeState`;
- cold/stop → `session.stop()`;
- wake → `createSession({ resumeFrom })`;
- **mid-turn DO eviction → best-effort** `session.suspendTurn()` in the shutdown
  window → persist `continuationState` → `continueStream()` on wake.

`CliEngine` approximates this with a workspace snapshot
(`sandbox.createBackup`/`restoreBackup` of `workDir` + the CLI's session dir) +
`--resume`. Two honesty notes the prior draft glossed:

1. **Claude `-p` cannot resume a killed turn.** `--resume` continues a session
   with a _new_ prompt; it does not re-attach to a half-finished, process-killed
   turn. So mid-turn recovery on `CliEngine` is **re-run**, and a naive re-run can
   **double-apply** edits/commits. Mitigation: reset the tree to the last
   checkpoint before re-running, and treat a dirty tree as the recovery signal.
2. **Snapshot cost must be bounded.** Backing up a `node_modules`-laden tree to
   R2 on every turn is slow/expensive. Make it incremental/conditional (skip when
   the tree is clean; consider excluding `node_modules` and re-`install` on
   restore). Verify that restoring the CLI's session dir into a _fresh_ container
   actually resumes before relying on it.

### 7. Configuration & topology

**Dynamic config (resolve, don't hardcode).** Config resolves by precedence:

```
configure() (persisted in DO storage)  >  this.props (sub-agent Props)  >  class-field default
```

Separate **immutable repo identity** from **mutable working state**: `repo` is
frozen on first turn (the workspace is built around it; changing it = a new
thread), but **`branch` / checkout are mutable in-session** — switching branches
is a `git checkout`, a normal coding move, not a new container. A
threaded/delegated coder gets config at spawn (`subAgent(MyCoder, id, { repo })`);
a standalone one via `@callable() configure({ repo })` before the first turn.

**Topology.** Three shapes, all from existing primitives:

1. **Standalone** — one DO, one repo.
2. **Threads (userland directory, not a shipped class).** A plain `Agent` owns a
   session table with domain-specific columns (`repo`/`branch`/`status`/`lastDiff`)
   and spawns one `CodingAgent` child per session. Gives the Codex-cloud /
   background-agents shape (dashboard, per-thread containers, cross-session memory
   via `RemoteContextProvider`) **without** a generic `Chats` base class (whose
   fixed schema is outgrown immediately — see the note in
   [`rfc-think-multi-session.md`](./rfc-think-multi-session.md)).
3. **Orchestrated** — a `Think` (or any agent) delegates via `codingAgentTool`,
   incl. `delegate_parallel` fan-out (the shipped example).

Requirement: **nothing in `CodingAgent` may assume a top-level binding** — it
must work as a directory child and as an agent-tool facet.

### 8. Testing & CI

Owning a _package_ (vs an example) raises the testing bar, so name it up front:

- **Unit:** engine mapping via recorded `stream-json` fixtures. Assert
  **semantic equivalence** (the resulting message/tool/diff shape), _not_ a
  byte-exact chunk sequence — exact-sequence golden tests churn on every benign
  CLI change. `HarnessEngine` inherits upstream's tested mapping.
- **Pin the CLI version** in the base image; a bump must update fixtures.
- **End-to-end** (real Docker + real CLI + real egress) can't run in
  `vitest-pool-workers`; gate it behind a **nightly / opt-in** job, not the PR
  path. Keep the PR path on fixtures.

## The alternatives

- **Make `CodingAgent` a `Think` subclass behind a new turn-runtime seam in Think
  core** (this RFC's original plan). Rejected: ~half of Think's surface is inert
  on a coding agent; the `_runInferenceLoop` refactor is the riskiest part of the
  plan and touches every existing Think user; and Think's replay-the-transcript
  model fights `HarnessAgent` reuse. `AIChatAgent.onChatMessage` already provides
  the seam with zero core changes.
- **Hand-roll the `stream-json` mapper as the only engine.** Rejected as the
  _end state_: `HarnessAgent` gives tested mapping + session lifecycle for free.
  We still ship `CliEngine` first (works today), but converge on `HarnessEngine`.
- **A subpath of `@cloudflare/think`.** Rejected: puts containers in the chat
  base, against the `AGENTS.md` layering preference; blocks independent deps.
- **Adopt `cloudflare/workspace` as the filesystem now.** Deferred (§10):
  preview-only / unstable with a large-file I/O penalty; spike behind a seam, do
  not couple v1.
- **Keep it an example, not a package.** Status quo — re-pays the integration
  cost per use and leaves durability unsolved.

## Directions (explicitly out of v1)

Captured so v1 doesn't preclude them; each is its own follow-up, **not** a
designed-in seam in v1 (we won't build interfaces before their second consumer
exists):

- **Durable-VFS filesystem** via [`cloudflare/workspace`](https://github.com/cloudflare/workspace):
  authoritative state in the DO, projected into the container as a FUSE mount,
  with a cheap Worker (`just-bash`) backend alongside the container backend. If it
  pans out it **supersedes the snapshot durability** of §6 (state lives in the DO,
  not the disk) and unifies the cheap-grep / heavy-`npm` split. Spike it.
- **Run / preview.** `vite dev` + Sandbox `exposePort` (any stack) vs
  `@cloudflare/worker-bundler` + `env.LOADER` (Workers-target, instant,
  scale-to-zero). Make the choice **explicit**, not auto-detected.
- **Git / PR ops** (`commit`/`openPR`) with a real credential design.
- **Per-tool HITL / approvals** brokered across the container boundary.
- **A Workers-native coding runtime** ("Runtime B"): a model-driven loop with
  coding tools on Workers, container only when needed, preview via `env.LOADER`.
  Could be a third engine behind the same `CodingAgent`. Enables a
  `delegate_parallel` "race CLI vs native" eval harness. Its own RFC.

## The decision

_Pending review._ Resolved by the discussion that drove the rewrite:

- ✅ **Own package, not a Think subpath / subclass.** `CodingAgent extends
AIChatAgent`; no Think core changes.
- ✅ **Engine is pluggable;** `CliEngine` ships first, `HarnessEngine` is the
  goal (gated on cloudflare/agents#1829).
- ✅ **No speculative multi-CLI adapter interface;** extract after codex.
- ✅ **Filesystem / preview are Directions, not v1 seams.**
- ✅ **Package name `@cloudflare/coding-agent`** with the `/claude-code` subpath
  convention.

Open questions still to settle (deliberately left open for now):

1. `HarnessEngine` vs `CliEngine` as the **default** for the first release —
   ship `CliEngine` now and migrate, or wait for #1829?
2. Snapshot policy for `CliEngine` durability (§6): what's backed up, how often,
   and the `node_modules` question.
3. First-PR scope: new package skeleton + `CliEngine` (lift the example's
   mapper) + tokenless egress + §6 durability + dynamic config + rewrite the
   example onto the package. Codex, `HarnessEngine`, preview, git ops, HITL, VFS
   deferred.

## History

- `examples/sandbox-coding-agent` (PR #1830) — the prototype this extracts.
- cloudflare/agents#1829 — `@ai-sdk/sandbox-cloudflare` provider (gates
  `HarnessEngine`).
- [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) — the "don't ship
  a `Chats` base class" decision the threads topology relies on.
