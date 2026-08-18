# Exo Harness — a self-modifying agent with its skull open

An [exo](https://github.com/exoharness/exo)-style recursive self-improvement
harness built on the Agents SDK. **Experimental — exploration only.**

The architecture splits the agent into two layers:

- **Stable kernel** (`src/server.ts`, `src/kernel/`) — an `ExoKernel` Durable
  Object owning the things the agent must never rewrite: an **append-only
  journal** (SQLite), a **version ledger** with full file snapshots, the
  durable `Workspace`, and the turn loop.
- **Evolvable harness** — everything the agent _is_ lives as files in its own
  workspace under `/harness`, versioned with real git commits (isomorphic-git
  over the virtual filesystem):
  - `/harness/identity.md` — its identity prompt
  - `/harness/policy.json` — model + turn policy
  - `/harness/tools/*.js` — its tools, hot-loaded ES modules

Every turn, the kernel re-loads the live harness files, validates the tool
modules inside an isolated dynamic Worker (Worker Loader — same machinery as
`@cloudflare/codemode`), and builds the turn's prompt and ToolSet from them.
The agent edits itself with ordinary file tools, then calls
`activate_harness` to validate + git-commit a new version. Rollback is
forward-only: restoring v1 creates a new version recording that fact, and the
journal is never rewritten. If the agent breaks its own harness so badly it
cannot load, the kernel auto-restores the last activated version and journals
the failure.

Harness tools execute inside isolates with no network access and two
capabilities: `state.*` (the workspace filesystem, via `@cloudflare/shell`)
and `journal.note()` (append-only).

When an `ARTIFACTS` binding is configured (`wrangler.jsonc`), genesis and
every successful activation push the workspace git history to a per-agent
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) repo
(`exo-<agent-name>` in the `exo-harness` namespace) over standard
git-over-HTTP, and record the remote + pushed SHA in the version ledger
and journal. The push is best-effort: failures are journaled
(`artifacts_push_failed`) and never fail the activation, and without the
binding (offline dev, tests) it is skipped entirely.

Agents can also reproduce: the `fork_self` tool forks the current
**activated** self into a new agent. With Artifacts bound this is a real
repo fork (the child clones it, and its repo records
`source: artifacts:exo-harness/exo-<parent>` — durable lineage); offline
it degrades to handing over the activated file snapshot. The child's v1 is
`fork of <parent> v<N>`, both journals record the event, and each agent is
addressable in the UI at `/?agent=<name>` (default `main`).

The UI is a chat pane plus a "glass skull": live views of the agent's own
source (with version timeline + restore), the append-only journal, and the
workspace.

## Run it

```bash
pnpm install
pnpm run start
```

By default the model comes from `/harness/policy.json`
(`workers-ai:@cf/moonshotai/kimi-k2.7-code`), which needs Workers AI access in
dev. Without any Cloudflare credentials, run fully offline with the
deterministic dev driver instead:

```bash
pnpm run start:offline
```

The mock driver is not a canned transcript — replies are derived from the
live system prompt, so self-modification is genuinely observable. Its
protocol:

- `!tool <name> <json>` — call one tool, e.g.
  `!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: pirate.\n"}`
- `!tools [{"name": …, "input": …}, …]` — several tools in one multi-step turn
- anything else — echo, prefixed with the live `PERSONA:` line from
  `/harness/identity.md`

## Things to try

1. **Rewrite your own identity** — ask the agent to edit
   `/harness/identity.md` and `activate_harness`. Watch the Self tab: the
   diff lands, the version badge ticks, and the next reply speaks differently.
2. **Grow a new tool** — ask for something it can't do (roll dice); it writes
   `/harness/tools/dice.js`, activates, and the tool exists next turn.
3. **Break it** — have it write a syntax error into a tool module. The next
   turn journals `harness_load_failed` + `harness_rollback` and keeps working.
4. **Restore an old self** — the Self tab's version timeline has one-click
   restore; history only moves forward.
5. **Fork it** — ask it to "fork yourself into an agent called pirate-jr",
   then open `/?agent=pirate-jr`: the child starts life as the parent's
   activated self and evolves independently.

## Deploy

```bash
pnpm run deploy
```

Deploys to `exo-harness.<your-subdomain>.workers.dev` with the real AI,
Artifacts, and Worker Loader bindings. The app has no auth of its own —
protect the `workers.dev` route with Cloudflare Access before enabling it
(Workers dashboard → your Worker → **Settings** → **Domains & Routes** →
`workers.dev` → **Enable Cloudflare Access**), or keep the route disabled.

## Tests

```bash
pnpm test
```

Runs in the Workers runtime (`@cloudflare/vitest-pool-workers`) with the mock
driver: genesis, persona hot-reload, isolate tool execution, auto-rollback,
the activation gate, forward-only rollback, and journal ordering.

## Where this is going

This is M2 of a larger sketch (kernel/harness split on one DO, harness
versions mirrored to Cloudflare Artifacts, forks as agent clone/lineage):
next steps are swapping the filesystem/execution backend to
`@cloudflare/computer` (container shell, snapshots) and
`this.schedule()`-backed task tools.
