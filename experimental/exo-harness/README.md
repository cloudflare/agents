# Exo Harness — a self-modifying agent with its skull open

An [exo](https://github.com/exoharness/exo)-style recursive self-improvement
harness built on the Agents SDK. **Experimental — exploration only.**

The architecture splits the agent into two layers:

- **Stable kernel** (`src/server.ts`, `src/kernel/`) — an `ExoKernel` Durable
  Object owning the things the agent must never rewrite: an **append-only
  journal** (SQLite), a **version ledger** with full file snapshots, the
  durable `Workspace` ([`@cloudflare/computer`](https://github.com/cloudflare/computer)
  — a SQLite-backed virtual filesystem with pluggable execution backends),
  and the turn loop.
- **Evolvable harness** — everything the agent _is_ lives as files in its own
  workspace under `/harness`, versioned with real git commits (the
  workspace's built-in isomorphic-git client):
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

Harness tools execute inside isolates (the workspace's worker-javascript
backend) with no network access: imports resolve straight from the durable
filesystem, `node:fs/promises` is backed by the workspace, and the
`ws:journal` trusted module gives tools an append-only journal capability.
The agent also has a shell — the `exec` tool runs just-bash in a Dynamic
Worker (worker-shell backend) over the same files, with text tools (grep,
sed, awk, jq, curl, sqlite) plus a `js` command and host-side `git`
and `artifacts` commands. No container anywhere; a full-Linux container
backend is the planned phase 2.

When an `ARTIFACTS` binding is configured (`wrangler.jsonc`), genesis and
every successful activation push the workspace git history to the agent's
session-scoped [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
mirror via the `createArtifact` facade: each agent owns the session
`<ARTIFACTS_REPO_PREFIX>-<agent-name>` (`exo-prod-*` deployed, `exo-dev-*`
local, so environments never share a mirror) and its repo is stored as
`<session>__self`. The remote + pushed SHA land in the version ledger and
journal. The push is best-effort: failures are journaled
(`artifacts_push_failed`) and never fail the activation, and without the
binding (offline dev, tests) it is skipped entirely.

The agent also manages its own context. `/harness/context.json` (self-
editable, kernel-clamped) sets its message window, a soft token target, and
which file is injected into its system prompt as working memory
(`/memory/core.md` by default). The `compact_history` tool distills older
conversation into that memory file using an **agent-authored** summary —
the kernel appends it immediately, then truncates the chat transcript at
the next turn start, leaving a visible "⌁ compacted…" marker in the chat.
When a turn exceeds the token target, the kernel adds a one-line pressure
nudge to its briefing — it never compacts on its own, and compaction never
touches the append-only journal. The Context tab shows all of it live: the
exact system prompt (with injected memory), the message window, and the
token estimate vs target.

Agents can give their future selves work: `schedule_task` creates
persistent tasks (once after a delay, at a time, or on a cron) backed by
the SDK scheduler, surviving hibernation and restarts. A fired task runs a
full autonomous turn outside the chat — same harness, memory, and tools —
and everything it does is journaled and visible in the Tasks tab. Kernel
rails, not agent-editable: max 10 active tasks, 48 runs/day, one firing
per 5 minutes, and a task that fails 5 times in a row is disabled with a
loud `task_disabled` journal entry (otherwise failures never cancel a
cron — least surprise). New tasks can only be created in human-initiated
turns: a scheduled turn's tool surface has no `schedule_task`.

The kernel also reserves every model step in the journal before inference.
Chat, prompt, tool-continuation, and scheduled steps share a fixed circuit
breaker: at 10,000 invocations in a rolling 24-hour window, the next step is
rejected before reaching the model. Failed requests remain counted; journal
records include only turn source and step number, never prompt content.

In production, Cloudflare Access identity selects the agent: the Worker
verifies the application identity and maps its stable subject to one isolated
`ExoKernel`. Browser URLs cannot select another agent. Forking is temporarily
absent from the model tool surface until child identities and Artifacts repos
are tenant-scoped; the underlying lineage implementation remains experimental.

The UI is a chat pane plus a "glass skull": live views of the agent's own
source (with version timeline + restore), the append-only journal, and the
workspace.

## Run it

```bash
pnpm install
cp .dev.vars.example .dev.vars # add your team gateway token
pnpm run start
```

By default, new agents use `openai/gpt-5.6-terra` from
`/harness/policy.json`. OpenAI models use the Responses API through the
managed team [AI Gateway](https://developers.cloudflare.com/ai-gateway/),
authenticated by `CLOUDFLARE_AIG_TOKEN` and attributed to
`agents-team-exo-harness`. Put the token in a local `.dev.vars` file for
`pnpm run start`; never commit it. `workers-ai:@cf/<id>` remains available
through the `AI` binding. Other third-party provider slugs are rejected.
`MODEL_OVERRIDE` forces a model for every agent and ignores policy. A failed
model call is journaled and shown safely in the chat pane. Local dev runs
under a separate worker name
(`wrangler.dev.jsonc`, `exo-harness-dev`): the remote-bindings tunnel uses
the worker's own `workers.dev` host, and the production host is behind
Cloudflare Access, which would otherwise 302 every binding call. Without
any Cloudflare credentials, run fully offline with the deterministic
dev driver instead:

```bash
pnpm run start:offline
```

The mock driver is not a canned transcript — replies are derived from the
live system prompt, so self-modification is genuinely observable. Its
protocol:

- `!tool <name> <json>` — call one tool, e.g.
  `!tool write_file {"path": "/harness/identity.md", "content": "PERSONA: pirate.\n"}`
- `!tools [{"name": …, "input": …}, …]` — several tools in one multi-step turn
- `!model-error` — simulate a failed model request
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
5. **Watch it remember** — after a conversation, ask it to "distill what
   matters into memory and compact the transcript". Watch the Context tab:
   the transcript shrinks, a "## Working memory" section appears in its
   system prompt, and it still recalls dropped details.
6. **Let it work alone** — "in two minutes, review your working memory and
   journal one insight about yourself". Watch the Tasks tab count down and
   the journal record the autonomous turn when it fires.
7. **Switch models** — ask it to set `/harness/policy.json` `"model"` to
   `workers-ai:@cf/moonshotai/kimi-k2.7-code` (or back to
   `openai/gpt-5.6-terra`) and `activate_harness`. The Context tab's model
   badge is the live spec.

## Deploy

Install the team gateway token without putting it in Wrangler vars or source,
then deploy:

```bash
pnpm exec wrangler secret put CLOUDFLARE_AIG_TOKEN
pnpm run deploy
```

Deploys to `exo-harness.<your-subdomain>.workers.dev` with the real AI,
Artifacts, and Worker Loader bindings. Production `/agent` requests fail
closed unless `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` identify a valid
hostname-based Cloudflare Access application. Configure that application
before enabling the route; Worker-level Access does not support this app's
WebSocket connection.

## Tests

```bash
pnpm test
```

Runs in the Workers runtime (`@cloudflare/vitest-pool-workers`) with the mock
driver: genesis, persona hot-reload, isolate tool execution, auto-rollback,
the activation gate, forward-only rollback, journal ordering, and the model
invocation circuit breaker.

## Where this is going

The substrate is `@cloudflare/computer` (preview): filesystem, git,
Artifacts facade, and both isolate execution backends. The remaining step
in the sketch is the container backend (`computerd` over FUSE) for a full
Linux userland — additive, since the workspace routes `exec` calls to
named backends.
