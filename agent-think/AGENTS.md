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
   │     failed-run continuation refreshes GitHub auth through gh-app's private
   │     AgentThinkTokenBroker binding before submitting into the same session
   ├─ ThinkAgent DO  (src/agent.ts) — owns durable turn/transcript state only
   ├─ WorkspaceAgent DO (src/workspace-agent.ts) — same stable per-issue name;
   │     exclusively owns Workspace VFS + backend connection. File tools and
   │     both bash backends share its RPC stub; the container backend claims
   │     from the warm pool per turn:
   │        resolveContainerId(env, id) → env.Sandbox.get(idFromName(uuid))
   ├─ Sandbox DO  (src/sandbox.ts)   — container host (wsd); handed out by pool
   ├─ WarmPool DO (src/warm-pool.ts) — keeps exactly one unassigned container warm
   ├─ CommandCenterAgent DO (src/command-center.ts) — singleton ("main")
   │     registry of every thread + per-thread counters; ThinkAgent reports
   │     lifecycle events fire-and-forget; failed runs are claimed atomically
   │     before an operator continuation
   └─ UI (React SPA, src/client.tsx): `/` command center (metrics, failed-run
      continuation, and ChatGPT-style thread sidebar, live via agents state
      sync); /thread/:session live thread view
```

Reactions are the liveness protocol (an "on it" comment was tried and removed
as noise): 👀 from gh-app = webhook seen and dispatched; 🚀 from the agent =
the MODEL's own first action (the system prompt tells it to `gh api` the
reaction from the container), so it proves the whole chain — turn awake,
container attached, gh authed, model responding. 👀 without 🚀 within a couple
of minutes = the run is dead, not slow. Results arrive as an issue comment
when the run finishes; gh-app posts ❌ if dispatch itself fails.

Session name = `<repo-slug>-<issue>` (e.g. `cloudflare-agents-1859`). Both
verbs on one issue reuse the same DO/workspace/thread, and `submitMessages`
uses idempotency key `repo#issue`, so webhook redeliveries and repeat mentions
join the existing turn instead of forking a second one.

Skills use Think's native R2 SkillSource and activation tools, independent of
the container's coding filesystem.

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
- **One Workspace owns `/workspace`.** Think internals and read/write/edit call
  the durable VFS directly. The lightweight shell operates on the same VFS, and
  the container backend runs against its mounted view. Workspace owns its sync
  policy; agent-think adds no path router or ignore policy. Paths outside
  `/workspace` remain container-local. Skills use Think's native R2 source.
- **Run identity is durable input, not prompt configuration.** The first user
  message carries an `<agent-think-run>` JSON envelope (repo, issue,
  instruction, requester, triggering comment). Skills fail closed without it.
  This survives context-block prompt assembly, eviction, and continuation.
- **Container ownership follows the turn.** The first container use claims a warm
  container. The Workspace keeps that connection for the turn. Terminal cleanup
  closes it, stops and drops the used container, and restores the one-container
  warm slot. There are no renewable leases, sticky idle assignments, or TTL policy.
- **Bash has two backends.** The lightweight VFS-backed `shell` is the default for
  text and file commands. Select `container` for gh, npm, node, native binaries,
  network access, builds, tests, and deploys. File tools call the VFS directly.
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
- **`/temp` is deliberately outside the VFS mount.** Put long logs there and
  tail them with container bash so neither the VFS nor tool results absorb the
  full output.
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

- Vitest configs live next to their suites: `test/vitest.config.ts` (Workers
  runtime module/DO tests) and `tests-e2e/vitest.config.ts` (real Wrangler +
  Docker infrastructure, with only inference replaced by a test subclass).
  `vite.config.ts` at the root builds only the thread UI into `dist/client`.
- Local-only HTTP surface (gated on `LOCAL_DEV=1`, set automatically by the
  e2e harness): `POST /dev/dispatch` and `GET /dev/messages/:session` — drive
  the full agent path without gh-app or webhooks.
- Deploys target the `agents` Cloudflare account
  (`CLOUDFLARE_ACCOUNT_ID=b8afc92c7a87f699592038b756153d22`).
- Model: `gpt-5.6-sol` with max reasoning through the OpenAI Responses API
  and team AI Gateway token, with a client-side fallback to
  `claude-opus-4-8` when the primary dispatch fails. Responses use
  `store: false`, so agent-think does not persist provider reasoning state.
- Agent-think uses the monorepo's Agents, AI Chat, and Think workspace
  packages and opts into full message/tool payload spans. The turn safety cap
  is 250 steps.
  Production reads `CLOUDFLARE_AIG_TOKEN` from a Worker secret and
  attributes every request to the `agents-team-agent-think` project. Local
  agent turns read the same variable from `.env`.

## Where the pieces live

- **This package**: the public agent (Worker, DOs, container image, skills,
  thread UI).
- **gh-app** (webhook ingress + GitHub App auth + triage/release automations):
  GitLab `cloudflare/ai-agents/team-apps`, `apps/gh-app` — private, holds the
  App credentials and the `AGENT_THINK` service binding.
