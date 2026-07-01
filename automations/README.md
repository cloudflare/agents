# automations

Feedback-loop automations for the Agents SDK — agents that run in CI to reduce
toil (triage, reproduction, fixes) so humans can focus on design.

The goal is to automate the build/measure/learn loop, not to one-shot
implementations. Each automation is a small [Flue](https://flueframework.com)
agent (powered by Pi) that runs in GitHub Actions.

## Agents

| Agent | Trigger | What it does | GH permissions |
| --- | --- | --- | --- |
| [`triage-agent`](./triage-agent) | every issue opened | applies fitting **existing** labels | `issues: write` |
| [`repro-agent`](./repro-agent) | `/repro` comment | builds + deploys a minimal reproduction, comments findings | `issues: write` |
| [`pr-agent`](./pr-agent) | `/pr` comment | one-shots a fix PR from the issue + repro | `contents: write`, `issues: write`, `pull-requests: write` |

CI entrypoints live in [`.github/workflows/`](../.github/workflows):
`triage.yml`, `repro.yml`, `pr.yml`.

### triage-agent (`/triage` → automatic)

Runs on every newly opened issue and applies labels from the repo's **existing**
label set. Hard constraints: it can **only** apply labels that already exist
(enforced by `gh issue edit --add-label`, which refuses unknown labels), and it
**cannot create labels or comment**. Workflow permissions are scoped to
`issues: write` only — no `pull-requests` access.

> **Future idea:** triage is a good candidate to become a *deployed* Think agent
> (a `@cloudflare/think` Worker that the workflow calls, or that receives the
> GitHub webhook directly) rather than a per-run CI agent — cheaper warm starts
> and shared memory across issues. Kept as a CI Flue agent for now for
> consistency with the others; revisit later.

### repro-agent (`/repro`)

1. Reads the issue with `gh`.
2. Scaffolds a minimal Agents/Worker reproduction using the canonical stack
   (`wrangler.jsonc` + `@cloudflare/think`/`agents` + Durable Objects), modeled
   on `think-starters/`.
3. Deploys it to a temporary Cloudflare preview account with
   `wrangler deploy --temporary` (no credentials needed; account is claimable
   for 60 minutes).
4. Verifies the bug actually reproduces against the live URL.
5. Comments the verdict, live URL, claim URL, minimal repro, and a root-cause
   hypothesis back on the issue.

### pr-agent (`/pr`)

1. Reads the issue **and all comments** — including any repro-agent findings and
   root-cause hypothesis.
2. Locates the root cause in `packages/`.
3. Branches, makes the smallest correct fix, adds/updates a test, and runs the
   affected package's format/lint/typecheck/tests (pnpm + Nx monorepo).
4. Pushes the branch and opens a PR that `Closes #<issue>`, then comments the PR
   link on the issue.

## Credentials

All three agents route LLM inference through the **Cloudflare AI Gateway** using
the same secrets the `bonk` workflow already uses:

| Purpose | Env var (in workflow) | Secret |
| --- | --- | --- |
| LLM inference via CF AI Gateway | `CLOUDFLARE_API_KEY` | `CF_AI_GATEWAY_TOKEN` |
| AI Gateway account | `CLOUDFLARE_ACCOUNT_ID` | `CF_AI_GATEWAY_ACCOUNT_ID` |
| AI Gateway slug | `CLOUDFLARE_GATEWAY_ID` | `CF_AI_GATEWAY_NAME` |
| Read issue / labels / push / PR | `GH_TOKEN` | `GITHUB_TOKEN` (auto) |

**Important credential boundary:** inference credentials live in the parent CI
process only. They are **not** forwarded into the agent's `local()` sandbox
shell — only `GH_TOKEN` is. For the repro-agent this is essential: it keeps
Wrangler unauthenticated inside the sandbox, which is required for
`wrangler deploy --temporary` (it errors if Cloudflare auth is present). The
model used is `cloudflare-ai-gateway/claude-opus-4-8`.

## Run locally

```bash
cd automations/<agent>          # repro-agent | pr-agent | triage-agent
npm install
export GH_TOKEN=$(gh auth token)
export CLOUDFLARE_API_KEY=...        # AI Gateway token
export CLOUDFLARE_ACCOUNT_ID=...     # AI Gateway account id
export CLOUDFLARE_GATEWAY_ID=...     # AI Gateway slug
npx flue run <reproduce|pr|triage> --target node --input '{"issueNumber": 123}'
```
