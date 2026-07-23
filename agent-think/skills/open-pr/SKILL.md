---
name: open-pr
description: Take a cloudflare/agents GitHub issue plus any repro findings and one-shot a fix PR — branch, change, test, push, and open the PR linked to the issue.
---

The current user message contains an `<agent-think-run>` envelope with
`repository`, `issue`, `instruction`, `requested-by`, and (when available)
`trigger-comment-id`.
Use those values exactly. Never infer or substitute another target from examples,
workspace contents, GitHub searches, or concurrent issues. If the envelope or a
required field is absent, stop without cloning/editing/pushing/posting and return a
structured skipped result. When `trigger-comment-id` is present, your first
container action is the liveness reaction:

```bash
gh api repos/<repository>/issues/comments/<trigger-comment-id>/reactions \
  -f content=rocket
```

Produce a focused fix PR, authored as **yourself** — the agent-think GitHub App.
Do not impersonate any user.

The instruction is the free-form text the user typed after `@agent-think` (it
may be empty). Treat it as a direct instruction — e.g. constraints
on the fix, a preferred approach, or a pointer to the suspect area — and weight
it highly, but stay within the scope of the issue.

All `gh`, `git`, `npm`, `curl`, and `wrangler` commands must run on the
`container` backend (`bash({ command, backend: "container" })`) — the `shell`
backend has no real binaries or network. `gh` is already authenticated as the
app; use it directly (no token handling). Work under `/workspace`; put long
logs and disposable scratch files in container-local `/temp`.

## 0. Clone the repo

Clone the target repo directly under `/workspace` using its repository name
(`cloudflare/agents` → `/workspace/agents`):

```bash
REPO_DIR="/workspace/$(basename <repo>)"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone https://github.com/<repo>.git "$REPO_DIR"
fi
cd "$REPO_DIR"
```

## 1. Gather everything known

```bash
gh issue view <issueNumber> --repo <repo> --json title,body,labels,author,comments
```

Read the body and **every comment**. In particular look for a comment from the
prior repro run (`@agent-think repro`): it may contain a minimal reproduction, a live URL,
observed-vs-expected behavior, and a **root-cause hypothesis** pointing at a
file/line. Use it as your starting point — do not re-derive what is already
known.

**Decide if this is fixable in one shot.** If the issue is a feature request
needing design, is too vague, spans many subsystems, or you cannot locate a
confident root cause, stop: return `prOpened: false`, `skipped: true`, and a
`summary` explaining why. Post a brief, polite comment saying the pr-agent is
skipping it and what additional detail would help; begin it with
`Requested by @<requestedBy>` when the run envelope has a requester.

## 2. Locate the root cause

With the repo cloned at `$REPO_DIR`, read the relevant code in
`packages/agents`, `packages/think`, etc. Confirm the hypothesis (or form your
own) by reading the actual implementation. Identify the smallest change that
fixes the reported behavior.

## 3. Branch and set commit identity

Commit as the agent-think app itself:

```bash
git config user.name "agent-think[bot]"
git config user.email "agent-think[bot]@users.noreply.github.com"
BRANCH="fix/issue-<issueNumber>-$(date +%s)"
git checkout -b "$BRANCH"
```

## 4. Make the fix

- Smallest correct change. Fewest files. Match the existing code style.
- Add or update a **test** that fails before the fix and passes after, when the
  area is testable.
- Add a changeset if the repo uses them (`.changeset/`) for a user-facing fix:
  create a markdown file following the existing format in `.changeset/`.
- Update **examples and docs** when the change affects behavior they show:
  if an `examples/*` app or a `docs/`/README section demonstrates the code you
  touched, keep it truthful in the same PR.

## 5. Verify

Install and run the affected package's checks (monorepo uses pnpm + Nx):

```bash
# NOISY commands (installs, builds, test suites) MUST be redirected to a
# container-local /temp file and tailed — streaming megabytes of live output
# through the session can kill it irrecoverably:
mkdir -p /temp
CI=1 pnpm install --frozen-lockfile --reporter=append-only \
  > /temp/install.log 2>&1 || (tail -40 /temp/install.log; false)
tail -20 /temp/install.log
# Prefer scoped/affected runs; fall back to package scripts.
pnpm -w exec oxfmt --check . || pnpm -w exec oxfmt --write .
pnpm -w exec oxlint . || true
# Run the relevant package's typecheck + tests, redirected the same way:
pnpm --filter <package> typecheck > /temp/typecheck.log 2>&1; tail -30 /temp/typecheck.log
pnpm --filter <package> test > /temp/test.log 2>&1; tail -40 /temp/test.log
```

(`/temp` is outside the `/workspace` mount and is not synchronized.)

Record whether tests passed in `testsPassed`. If you cannot make tests pass and
the failure is your change's fault, fix it; if tests are unrelated/flaky, note
that in the PR body. Do not open a PR whose own new test fails.

## 6. Deploy a live demo of the PR

Every PR ships with a **temporary deployment demoing the change** so reviewers
click a link and see the fixed behavior instead of imagining it.

1. Build the fixed package(s) in the repo and pack them:

```bash
pnpm --filter <package> build
(cd packages/<package> && npm pack --pack-destination /workspace)   # -> /workspace/<package>-x.y.z.tgz
```

2. Build a minimal demo app in `/workspace/demo-<issueNumber>` that exercises
   the fixed path. Follow the activated reproduce skill's **"Minimal frontend
   (required)"** recipe — same 7 files — but install the packed tarball so the
   demo runs YOUR fix:

```bash
npm install /workspace/<package>-x.y.z.tgz
```

If the repro run left a `repro/issue-<issueNumber>` branch, start from that
project instead and just swap the dependency to the packed build — the same
UI then demos broken-before / fixed-after.

3. Deploy and verify the fix is actually observable in the page:

```bash
npm run deploy      # vite build && wrangler deploy --temporary
curl -sS -i "<demoUrl>/" | head -5
```

Capture the `https://...workers.dev` URL as `demoUrl`. Ignore the claim URL
the deploy prints — it never goes in a PR.

Use judgment: changes with no runtime surface (docs-only, types-only, CI) skip
the demo — say so in the PR body ("no runtime surface to demo") rather than
deploying something meaningless.

## 7. Commit, push, open the PR

```bash
git status --short
git add -A
git commit -m "fix: <concise description> (#<issueNumber>)"
git push -u origin "$BRANCH"

gh pr create --repo <repo> \
  --base main \
  --head "$BRANCH" \
  --title "fix: <concise description> (#<issueNumber>)" \
  --body-file /temp/pr-body.md
```

Write the PR body outside the checkout at `/temp/pr-body.md`. It must include:

- `Requested by @<requestedBy>` near the top, using the exact sanitized
  `requested-by` mention from the run envelope (omit only when it is `unknown`).
- `Closes #<issueNumber>` so the issue auto-links.
- **What was wrong** (root cause, citing the file/line).
- **What changed** and why this is the minimal fix.
- **Testing**: what you added/ran and the result.
- **Demo**: phrase it exactly like "Demo URL (expires after 60 mins):
  <demoUrl>" plus one line of click instructions and a note that it runs the
  packed build from this branch. If skipped, one line on why.
- A link back to the repro-agent's reproduction (comment and/or the
  `repro/issue-<issueNumber>` branch) if one exists.
- A "🤖 generated by the pr-agent — please review carefully" footer.

Capture the PR URL and branch name.

Do **not** post an acknowledgement or "opened a PR" comment on the issue. The
PR links back to the issue via `Closes #<issueNumber>`. The only case where you
comment is the skip path in the **Gather everything known** step (no PR
exists to show).

## 8. Return the structured result

Return exactly:

- `prOpened` (boolean)
- `skipped` (boolean)
- `summary` (string — one or two sentences)
- `prUrl` (string, optional)
- `branch` (string, optional)
- `testsPassed` (boolean, optional)
- `demoUrl` (string, optional)
