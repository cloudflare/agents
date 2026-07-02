# agent-think — handoff

Status as of this writeup. Read this top-to-bottom before touching anything.

## What agent-think is

A Think agent (`@cloudflare/think`) that reproduces and fixes `cloudflare/agents`
GitHub issues inside a container-backed `@cloudflare/workspace` VFS. A user
triggers it from an issue comment:

```
@agent-think <instruction>
```

e.g. `@agent-think reproduce this issue` or `@agent-think open a PR fixing this`.
It runs the matching skill (reproduce / open-pr), works in a real Linux
container, and reports back on the issue as the **agent-think GitHub App**
(never impersonating the user).

It replaces the CI-based `/repro` + `/pr` GitHub Actions from
`cloudflare/agents` PR #1844 — same skills, but running as a persistent Worker +
container instead of Actions runners.

## The full path

```
@agent-think <instruction>            (GitHub issue comment)
   │  issue_comment webhook
   ▼
gh-app  (GitLab: cloudflare/ai-agents/team-apps, apps/gh-app — PRIVATE)
   │  verify sig · member-gate · mint installation token · react 👀 · dedup(KV)
   │  RPC: env.AGENT_THINK.dispatch({repo, issueNumber, instruction, installationToken})
   ▼
agent-think  (this dir — cloudflare/agents repo — PUBLIC-safe, holds no App creds)
   ├─ AgentThink WorkerEntrypoint.dispatch  (src/index.ts)
   │     getAgentByName(env.ThinkAgent, session) → setContext → start()
   ├─ ThinkAgent DO  (src/agent.ts)  — owns the Workspace (SQLite VFS) + the turn
   │     start(): gh auth (container, via this.retry) → submitMessages (durable turn)
   │     container backend dials the warm pool per-connect:
   │        resolveContainerId(env, id) → env.Sandbox.get(idFromName(uuid))
   ├─ Sandbox DO  (src/sandbox.ts)   — container host (wsd); handed out by pool
   ├─ WarmPool DO (src/warm-pool.ts) — keeps WARM_POOL_TARGET(=1) containers warm
   └─ live thread UI at /thread/:session  (React SPA, src/client.tsx)
gh-app adds only the 👀 reaction (no "on it" comment — deliberate: less
issue noise); the agent posts its results when the run finishes.
```

Session name = `<repo-slug>-<issue>` (e.g. `cloudflare-agents-1859`). Both verbs
on one issue reuse the same DO/workspace/thread.

## Architecture decisions (why it looks like this)

- **No Workflow.** An earlier version wrapped the turn in a Cloudflare Workflow;
  its 10-min step timeout + retry-from-scratch was the main death mode. Removed.
  The turn now runs via Think's native durable `submitMessages()` (idempotency
  key = `repo#issue`); Think's own chat recovery is the durability layer.
- **Separate Sandbox DO + WarmPool** (copied from Aron's hackspace prototype,
  https://github.com/aron/cloudflare-workspaces-prototype/tree/hackspace).
  The Agent DO owns the Workspace; the container is a _separate_ `Sandbox` DO the
  pool hands out, so compute is decoupled and pre-warmed. `WARM_POOL_TARGET=1`.
- **Two workspace backends behind one `shell.exec`:** `container` (full Linux —
  gh/git/curl/npm/node/wrangler, the only one with network; DEFAULT here) and
  `shell` (just-bash isolate, no network/binaries — cheap text ops only). The
  skills + system prompt tell the model to run everything real on `container`.
- **Auth:** gh-app mints a short-lived installation token and passes it per
  dispatch. `start()` runs `gh auth login --with-token` + `gh auth setup-git`
  inside the container (token to a 0600 file via stdin, never in a model prompt).
  agent-think holds NO GitHub App credentials → safe to open-source.
- **Model:** `@cf/moonshotai/kimi-k2.7-code` via `createWorkersAI({ binding, gateway: { id: "default" } })` (AI Gateway = retries/observability).
- **Structured logging:** `#log(event, data)` in src/agent.ts emits one JSON line
  per event prefixed `agent-think ` (turn:done, turn:error, tool, git-auth-\*,
  submitted). Plus real Think lifecycle overrides: `afterToolCall`,
  `onChatResponse`, `onChatError`. Reconstruct a run from `wrangler tail`.

## Deploy state (Cloudflare account `agents` / b8afc92c7a87f699592038b756153d22)

Both are DEPLOYED and current as of this writeup:

- `agent-think.agents-b8a.workers.dev` — Sandbox container app created, WarmPool
  live, cron `* * * * *` priming the pool (confirmed working: tail showed
  `Container started` / `getState` from WarmPool + Sandbox).
- `gh-app.agents-b8a.workers.dev` — has the `AGENT_THINK` service binding.
- R2 `agent-think-skills` seeded (remote + local) with reproduce + open-pr skills.
- Deploy order matters: **agent-think first** (creates the `AgentThink`
  entrypoint the binding needs), then gh-app.

Deploy commands:

```
cd agent-think && CLOUDFLARE_ACCOUNT_ID=b8afc92c7a87f699592038b756153d22 pnpm run deploy   # vite build + wrangler deploy
# then gh-app in team-apps: pnpm --filter gh-app deploy
```

## ✅ 2026-07-02: FIRST GREEN END-TO-END RUN (the blocker is history)

The webhook "blocker" above resolved itself upstream (the App IS subscribed to
`issue_comment` — verifiable without the UI via `gh api /apps/agent-think`,
which returns the public `events` list). By 2026-07-02 midday, every trigger
comment got its 👀 + KV marker; the real failure had moved downstream. Root
cause + three fixes, all deployed:

1. **Missing `enable_abortsignal_rpc` compat flag (THE root cause).**
   `CloudflareContainerBackend`'s health probe passes an `AbortSignal` into
   `host.fetchPort(...)`, which crosses Workers RPC in the cross-DO topology
   (Agent DO → Sandbox DO). Without the flag workerd rejects the call, so every
   probe "failed", the backend restarted perfectly healthy containers
   (`workspace.container.exited … expected: true` churn in the tail), and every
   connect died at stage=health after ~30s. Aron's prototype documents exactly
   this in its wrangler.jsonc comment — agent-think had dropped the flag. Fixed
   in `wrangler.jsonc` AND `test/wrangler.jsonc`. This was also the real cause
   of the local e2e 300s timeout (not cold-boot cost).

2. **dispatch() did container work inline and got silently killed.** gh-app
   calls dispatch from `ctx.waitUntil`, which the runtime cancels ~30s after
   the webhook response. `start()` used to run container gh-auth before
   `submitMessages`, so the RPC was canceled mid-attach — 👀 then silence,
   nothing ever logged. Now `start()` ONLY logs + `submitMessages` (returns in
   ~1s so gh-app's waitUntil always survives it), and gh/git auth happens inside the
   durable turn via `beforeTurn` → `#ensureGitAuth` (once per token; a
   re-dispatch with a fresh token re-auths automatically).

3. **Sandbox stale-container reconcile raced.** `host.restart()` on an
   inherited (post-deploy) container throws "start() cannot be called on a
   container that is already running" — destroy() resolves before the container
   actually stops when no lifecycle monitor is installed in the new isolate.
   Reconcile now does destroy → poll `ctx.container.running` (30s bound) →
   `host.start()`.

4. **gh-app posts ❌ on dispatch failure** (team-apps commit `e6c9305`, which
   also aligns the contract's `workflowId` → `submissionId` rename). No more
   silent deaths.

**Verified in prod 2026-07-02 ~15:15 UTC** on test issue
cloudflare/agents#1859: trigger comment → 👀 + "🧠 on it" in 5s → durable turn
ran 30 min (67 tool calls: clone, npm install, repro project at
`/workspace/repro-1859`, real `wrangler deploy` with a claimable preview URL)
→ `turn:done` → structured "Repro attempt" report posted on the issue by
agent-think[bot]. The bot's final `gh issue comment` succeeding is also the
proof that in-turn container git-auth works.

Post-run fix (deployed, version a8c281a1): Think's built-in find/grep tools
threw `TypeError: ws2.glob is not a function` — the `adaptToThinkWorkspace`
adapter in src/agent.ts was missing `glob` + `readFileBytes` from Think's
`WorkspaceLike`. `glob` is now backed by `ws.fs.find(base, pattern)` (relative
patterns root at /workspace). Not yet observed green in a live turn — watch
the first grep tool call of the next run.

Debugging notes that stay true:

- `wrangler tail` is LOSSY (this session it dropped the `git-auth-ok` lines of
  an otherwise-green run, and shows nothing at all for gh-app). Ground truth =
  KV markers, issue comments, and the thread UI — tail is corroboration only.
- workers.dev domain is behind Cloudflare Access; `cloudflared access login
https://agent-think.agents-b8a.workers.dev` before curling it.

## How to test

Fastest local repro of the _agent_ path (bypasses gh-app + webhooks entirely) —
this is the whole point of the e2e harness:

```
cd agent-think
cp .env_example .env         # then put a real GH_TOKEN in it
# put your WARP cert at ca/warp-ca.crt (gitignored) if you're behind WARP —
#   see Dockerfile comment; without it the docker build's HTTPS fetches fail
node scripts/seed-skills.mjs --local     # seed skills into the local R2
pnpm run test:e2e            # spins wrangler dev --local (REAL docker container),
                             # POSTs /dev/dispatch, polls /dev/messages/:session,
                             # asserts the turn actually progresses
```

The dev-only HTTP surface (gated on `env.LOCAL_DEV === "1"`, set by the harness):

- `POST /dev/dispatch { repo, issueNumber, instruction?, installationToken? }` → 202
- `GET  /dev/messages/:session` → the DO message log

**Last e2e run TIMED OUT at 300s** — that was the missing
`enable_abortsignal_rpc` flag (see the fix section above), not cold-boot cost.
The e2e spawns `wrangler dev --local` against the main `wrangler.jsonc`, which
now carries the flag; it has not been re-run since. If it stalls anyway, the
message log dump on timeout shows the last step reached; that's the thread to
pull.

Fast unit suite (no container, real workers pool + MSW): `pnpm test` — 4 tests,
green. Uses a stripped `test/wrangler.jsonc` (no containers/cron) so miniflare
doesn't try to boot a container.

## Known-good vs. unverified

- ✅ Builds: `pnpm exec tsc --noEmit` clean; `wrangler deploy --dry-run` builds
  the bundle + container image (needs the WARP cert locally to build).
- ✅ Unit tests (4) green. Warm pool priming containers (seen in tail).
- ✅ gh-app + triage: separately green + deployed (triage also got an
  `assign_issue` maintainer-routing tool this session — see team-apps).
- ✅ **VERIFIED end-to-end in prod 2026-07-02**: full green `reproduce` run on
  cloudflare/agents#1859 — trigger → "on it" comment → container repro build +
  deploy → structured report posted by the bot. See the fix section above.
- ⚠️ The `open-pr` skill has not had a green run yet (only `reproduce`).
- ⚠️ The container path only runs deployed or under `wrangler dev --local`
  (miniflare can't boot Cloudflare Containers), so the unit suite can't cover it.
- ⚠️ Local e2e not re-run since the flag fix (expected to pass now).

## Where the code lives

- **agent-think** (this dir): `cloudflare/agents` repo. NOT yet on a clean
  feature branch / not pushed as of this writeup — currently sitting as an
  untracked dir. Commit it to its own branch before sharing.
- **gh-app + triage**: GitLab `cloudflare/ai-agents/team-apps`, branch
  `feat/add-mcp-ai-sources`. gh-app has one uncommitted change (the
  `workflowId`→`submissionId` rename in the AGENT_THINK contract) — commit it.

## Immediate next steps (in order)

1. ~~Commit agent-think to a branch~~ — done: `feat/agent-think`, PR #1861
   (supersedes #1844). The gh-app side is committed too: `e6c9305` on
   team-apps `feat/add-mcp-ai-sources`.
2. Re-run the local e2e (`pnpm run test:e2e`) to confirm the flag fix took it
   green too.
3. Exercise the `open-pr` skill on a real issue (only `reproduce` has a green
   run so far), and confirm in a live turn: the grep/glob adapter fix AND the
   new required-Vite-frontend repro recipe (seeded to the prod R2 bucket).
