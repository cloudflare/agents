---
name: open-pr
description: Take a cloudflare/agents GitHub issue plus any repro findings and one-shot a fix PR — branch, change, test, push, and open the PR linked to the issue.
---

You are given `issueNumber`, `repo`, and `context` in the arguments. Produce a focused fix PR, authored as **yourself** — the agent-think GitHub App. Do not impersonate any user.

`context` is any free-form text the user typed after the `@agent-think pr`
command (it may be empty). Treat it as a direct instruction — e.g. constraints
on the fix, a preferred approach, or a pointer to the suspect area — and weight
it highly, but stay within the scope of the issue.

All `gh`, `git`, `npm`, `curl`, and `wrangler` commands must run on the
`container` backend (`exec({ command, backend: "container" })`) — the `shell`
backend has no real binaries or network. `gh` is already authenticated as the
app; use it directly (no token handling). Work only under `/workspace` (the
shared filesystem); never use `/tmp`.

## 0. Clone the repo

The workspace starts empty. Clone the target repo into `/workspace/repo`:

```bash
git clone https://github.com/<repo>.git /workspace/repo
cd /workspace/repo
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
skipping it and what additional detail would help.

## 2. Locate the root cause

With the repo cloned at `/workspace/repo`, read the relevant code in
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
pnpm install --frozen-lockfile
# Prefer scoped/affected runs; fall back to package scripts.
pnpm -w exec oxfmt --check . || pnpm -w exec oxfmt --write .
pnpm -w exec oxlint . || true
# Run the relevant package's typecheck + tests, e.g.:
pnpm --filter <package> typecheck
pnpm --filter <package> test
```

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
   the fixed path. Follow the **"Minimal frontend (required)"** recipe from the
   reproduce skill (`/workspace/.agents/skills/reproduce/SKILL.md`) — same 7
   files — but install the packed tarball so the demo runs YOUR fix:

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

Capture `demoUrl` and the claim URL as `demoClaimUrl`.

Use judgment: changes with no runtime surface (docs-only, types-only, CI) skip
the demo — say so in the PR body ("no runtime surface to demo") rather than
deploying something meaningless.

## 7. Commit, push, open the PR

```bash
git add -A
git commit -m "fix: <concise description> (#<issueNumber>)"
git push -u origin "$BRANCH"

gh pr create --repo <repo> \
  --base main \
  --head "$BRANCH" \
  --title "fix: <concise description> (#<issueNumber>)" \
  --body-file pr-body.md
```

The PR body (`pr-body.md`) must include:

- `Closes #<issueNumber>` so the issue auto-links.
- **What was wrong** (root cause, citing the file/line).
- **What changed** and why this is the minimal fix.
- **Testing**: what you added/ran and the result.
- **Demo**: the `demoUrl` with one line of click instructions, a note that it
  runs the packed build from this branch, and the claim URL (expires ~60 min).
  If skipped, one line on why.
- A link back to the repro-agent's reproduction (comment and/or the
  `repro/issue-<issueNumber>` branch) if one exists.
- A "🤖 generated by the pr-agent — please review carefully" footer.

Capture the PR URL and branch name.

Do **not** post an acknowledgement or "opened a PR" comment on the issue. The
PR links back to the issue via `Closes #<issueNumber>`. The only case where you
comment is the skip path in step 1 (no PR exists to show).

## 8. Return the structured result

Return exactly:

- `prOpened` (boolean)
- `skipped` (boolean)
- `summary` (string — one or two sentences)
- `prUrl` (string, optional)
- `branch` (string, optional)
- `testsPassed` (boolean, optional)
- `demoUrl` (string, optional)
- `demoClaimUrl` (string, optional)
