# agent-think

A Think agent (`@cloudflare/think`) that reproduces and fixes `cloudflare/agents`
GitHub issues inside a container-backed `@cloudflare/workspace` VFS. Anyone
trusted on the repo triggers it from an issue comment:

```
@agent-think <instruction>
```

e.g. `@agent-think reproduce this issue` or `@agent-think open a PR fixing this`.
It runs the matching skill (reproduce / open-pr) in a real Linux container and
reports back on the issue as the **agent-think GitHub App** — never
impersonating the triggering user.

## Aims

- Replace CI-runner automations (the `/repro` + `/pr` Actions shape from
  PR #1844) with **one persistent Worker + pre-warmed container**: webhook to
  running agent in seconds, durable turns that survive eviction, one shared
  workspace/thread per issue.
- **Reproductions a human can see.** Every repro deploys with a minimal Vite
  frontend — click the `workers.dev` link, press _Trigger bug_, watch
  expected-vs-actual in the page (deployed via `wrangler deploy --temporary`
  with a claimable preview account).
- Multiplayer for the team: sessions are per-issue, not per-user, and the live
  thread UI (behind Cloudflare Access) shows any run in flight.

## How it works

```
@agent-think <instruction>            (GitHub issue comment)
   │  issue_comment webhook
   ▼
gh-app  (GitLab: cloudflare/ai-agents/team-apps, apps/gh-app — PRIVATE)
   │  verify sig · member-gate · mint installation token · react 👀 · dedup(KV)
   │  RPC: env.AGENT_THINK.dispatch({repo, issueNumber, instruction, installationToken})
   ▼
agent-think  (this dir — PUBLIC-safe, holds no App creds)
   ├─ AgentThink WorkerEntrypoint.dispatch  (src/index.ts)
   │     getAgentByName(env.ThinkAgent, session) → setContext → start()
   │     start() ONLY submits the durable turn — returns in ~1s
   ├─ ThinkAgent DO  (src/agent.ts) — owns the Workspace (SQLite VFS) + the turn
   │     gh/git auth runs INSIDE the turn (beforeTurn → #ensureGitAuth);
   │     container backend dials the warm pool per-connect:
   │        resolveContainerId(env, id) → env.Sandbox.get(idFromName(uuid))
   ├─ Sandbox DO  (src/sandbox.ts)   — container host (wsd); handed out by pool
   ├─ WarmPool DO (src/warm-pool.ts) — keeps WARM_POOL_TARGET(=1) containers warm
   ├─ CommandCenterAgent DO (src/command-center.ts) — singleton ("main")
   │     registry of every thread + per-thread counters; ThinkAgent reports
   │     lifecycle events fire-and-forget (observing must never break a run)
   └─ UI (React SPA, src/client.tsx): `/` command center (metrics + ChatGPT-
      style thread sidebar, live via agents state sync); /thread/:session
      live thread view
```

The 👀 reaction is the only pickup signal (an "on it" comment was tried and
removed as noise); the agent posts its results on the issue when the run
finishes, and gh-app posts a ❌ comment if dispatch itself fails.

Session name = `<repo-slug>-<issue>` (e.g. `cloudflare-agents-1859`). Both
verbs on one issue reuse the same DO/workspace/thread, and `submitMessages`
uses idempotency key `repo#issue`, so webhook redeliveries and repeat mentions
join the existing turn instead of forking a second one.

Skills are mounted read-only from R2 at `/workspace/.agents/skills`; the model
picks the skill(s) matching the free-form instruction — there is no fixed verb.

## Rules we hold ourselves to

- **agent-think holds NO GitHub App credentials.** gh-app (private) mints a
  short-lived installation token per dispatch. In the container the token goes
  to a 0600 file over stdin (`gh auth login --with-token`) — never in a model
  prompt, process argument, or log. That is what makes this dir safe to keep
  in a public repo.
- **The agent acts as the App, never as a person.** Branches, commits, PRs,
  and comments are authored by agent-think[bot].
- **Member-gated.** Only comment authors with OWNER / MEMBER / COLLABORATOR
  association can drive it (it runs code and opens PRs).
- **`dispatch()` does no container work.** gh-app calls it inside
  `ctx.waitUntil`, which the runtime cancels ~30s after the webhook response.
  Anything slow (container attach, gh auth) must live inside the durable turn,
  where no caller can cancel it. Keep dispatch ~1s forever.
- **No Cloudflare Workflow.** An earlier shape wrapped the turn in a Workflow;
  its 10-min step timeout + retry-from-scratch was the main death mode. Think's
  native durable `submitMessages` is the durability layer.
- **Compute is decoupled from state** (Aron's hackspace pattern:
  github.com/aron/cloudflare-workspaces-prototype, `hackspace` branch). The
  Agent DO owns the Workspace; containers are separate warm-pooled Sandbox DOs.
  When container behavior surprises you, diff against that prototype first.
- **Everything real runs on the `container` backend** (the only one with a
  toolchain + network). The `shell` backend is a just-bash isolate for cheap
  text ops. The skills + system prompt enforce this split.
- **Repros must be clickable.** The reproduce skill mandates a minimal
  Vite + React page (exact 7-file recipe in the skill) so maintainers see the
  failing behavior without cloning anything.

## Edge cases you will hit

- **`enable_abortsignal_rpc` is required** (`wrangler.jsonc` AND
  `test/wrangler.jsonc`). The container backend's health probe passes an
  `AbortSignal` into `host.fetchPort(...)`, which crosses Workers RPC in the
  cross-DO topology. Without the flag workerd rejects every probe, the backend
  "restarts" perfectly healthy containers in a loop, and connects die at
  stage=health after ~30s. This one cost us a day.
- **`wrangler tail` is lossy.** It drops lines mid-run and shows nothing at
  all for gh-app. Ground truth is: KV `handled:*` markers (gh-app's
  EVENT_STATE), issue reactions/comments, and the thread UI. The structured
  `agent-think {...json}` log lines (start / submitted / tool / git-auth-\* /
  turn:done / turn:error) reconstruct a run when tail does cooperate.
- **Stale containers after a deploy.** The platform can keep a container
  alive across a deploy while the new isolate has no lifecycle monitor for it.
  The Sandbox constructor reconciles by destroy → poll `running` → start; do
  NOT "simplify" it back to `host.restart()` — on an inherited container
  destroy() resolves before the container actually stops and the inner
  start() throws "already running", leaving the wedged container in place.
- **miniflare cannot boot Cloudflare Containers.** The fast unit suite runs on
  a stripped `test/wrangler.jsonc` (no `containers`, no cron) and never touches
  the container path; that path is only covered by the e2e suite
  (`wrangler dev --local` + real docker) or in prod.
- **The workers.dev domain is behind Cloudflare Access.**
  `cloudflared access login https://agent-think.agents-b8a.workers.dev` before
  curling it; thread links only work for people on the account's Access policy.
- **Building the image behind WARP** (or any TLS-inspecting proxy): drop the
  proxy CA at `ca/warp-ca.crt` (gitignored; `ca/.keep` keeps the COPY source
  alive). Without it the Docker build's HTTPS fetches fail with certificate
  errors. Hosts without WARP need nothing.
- **Editing `skills/**` does nothing until you reseed R2**
(`npm run seed:r2`, or `-- --local` for local dev). The deployed worker
  reads skills from the bucket, not from the repo.
- **Deploy order matters**: agent-think first (creates the `AgentThink`
  entrypoint), then gh-app (whose service binding points at it).
- **Dedup semantics**: gh-app marks `handled:comments:<id>` BEFORE dispatch,
  so a failed dispatch is not retried by webhook redelivery — that's what the
  ❌ comment is for. Issue-level triage marks only after success (retryable).
- **A re-mention with a fresh token mid-turn is fine**: `#ensureGitAuth`
  re-auths whenever the context token changes (checked every `beforeTurn`).
- **WebSocket upgrades need `run_worker_first`.** The assets layer passes
  ordinary no-asset-match requests through to the worker, but NOT WebSocket
  upgrades — a WS to `/agents/*` dies at the assets router unless the path is
  in `run_worker_first`. Symptom: the UI's HTTP calls work while every
  `wss://` connect fails. (This bit us on the command center; the repro-skill
  recipe carries the same rule.)
- **Deploys reset in-flight turns.** A deploy lazily resets every DO onto the
  new code; a running turn loses its container connection and burns minutes on
  Think's (working) recovery — it re-auths and resumes, but don't deploy while
  runs are active. Check for recent turn activity first (observability logs /
  the command center).

## Development

```
pnpm test        # fast unit suite: workers pool + MSW, no container
pnpm test:e2e    # real `wrangler dev --local` + docker container + real turn
                 #   needs .env (cp .env_example .env, set GH_TOKEN)
                 #   first run builds the image — slow; see WARP note above
pnpm run deploy  # vite build (thread UI) + wrangler deploy (worker + image)
npm run seed:r2  # push skills/** to the R2 bucket (add -- --local for dev)
```

- Vitest configs live next to their suites: `test/vitest.config.ts` (unit) and
  `tests-e2e/vitest.config.ts` (e2e). `vite.config.ts` at the root builds only
  the thread UI into `dist/client`.
- Local-only HTTP surface (gated on `LOCAL_DEV=1`, set automatically by the
  e2e harness): `POST /dev/dispatch` and `GET /dev/messages/:session` — drive
  the full agent path without gh-app or webhooks.
- Deploys target the `agents` Cloudflare account
  (`CLOUDFLARE_ACCOUNT_ID=b8afc92c7a87f699592038b756153d22`).
- Model: `openai/gpt-5.5` through the account's default AI Gateway
  (`createWorkersAI({ binding, gateway, providers: [openai] })` — the catalog
  slug routes via the gateway delegate; Unified Billing, no OpenAI key).
  NOTE: the `providers: [openai]` plugin is REQUIRED for `{provider}/{model}`
  slugs — without it workers-ai-provider refuses to build the model.

## Where the pieces live

- **This package**: the public agent (Worker, DOs, container image, skills,
  thread UI).
- **gh-app** (webhook ingress + GitHub App auth + triage/release automations):
  GitLab `cloudflare/ai-agents/team-apps`, `apps/gh-app` — private, holds the
  App credentials and the `AGENT_THINK` service binding.
