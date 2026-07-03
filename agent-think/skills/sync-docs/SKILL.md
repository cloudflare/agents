---
name: sync-docs
description: Inspect the pull request where @agent-think was mentioned, identify user-facing features, patch only the necessary pages in cloudflare/cloudflare-docs through a tiny sparse checkout, open a draft docs PR, and repair failures when docs CI wakes the agent.
---

You are given `issueNumber`, `repo`, and `context`. For this skill,
`issueNumber` is the number of the **source pull request** whose conversation
contained `@agent-think sync docs`; `context` is the rest of that comment.
Produce a focused documentation PR in `cloudflare/cloudflare-docs`, authored as
the **agent-think GitHub App**. Never impersonate the requester.

All `gh`, `git`, `curl`, `npm`, `node`, and package-manager commands must run on
the `container` backend (`exec({ command, backend: "container" })`). `gh` and
`git` are already authenticated as the App. Never print or reconfigure the
token. Work only under `/workspace`; never use `/tmp`.

There are two entry paths:

1. **Initial sync** — inspect the source PR, create the docs patch, and open a
   draft docs PR.
2. **CI continuation** — gh-app receives `workflow_run.completed` for the docs
   PR and submits a new durable message to this same Think session with the run
   id, conclusion, head SHA, and repair attempt. Reuse the existing checkout
   and PR. Never open a second PR during a continuation.

## Initial sync

### 1. Verify and inspect the source PR

Confirm that the number is a pull request, not an issue:

```bash
gh pr view <source-pr> --repo <source-repo> \
  --json number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid,author,comments,commits,files
```

If it is not an open PR, stop and return a skipped result.

Determine the PR's **user-facing behavior**, not merely its changed filenames.
Read its title, description, commits, all conversation comments, and changed
file list. Start with bounded output:

```bash
gh pr diff <source-pr> --repo <source-repo> --name-only
gh api "repos/<source-repo>/pulls/<source-pr>/files?per_page=100" --paginate \
  --jq '.[] | {filename,status,additions,deletions,patch}'
```

When the PR is large, inspect only relevant patches and retrieve specific base
or head files through the Contents API. Do not dump a huge whole-PR diff into
one tool result. Distinguish:

- new public APIs, options, behavior, examples, migrations, or limitations that
  users need to understand;
- implementation details, tests, internal refactors, and fixes that do not
  change documented behavior.

If there is no documentation impact, do not create an empty or speculative PR.
Post/update the source status comment with the no-change verdict and return a
skipped result.

### 2. Find the existing documentation before cloning

The docs repository is very large. Never perform a normal/full clone. Search
GitHub first with a few focused API calls using public symbols, package names,
and concepts from the source PR:

```bash
gh search code '<term> repo:cloudflare/cloudflare-docs' \
  --limit 20 --json path,url,textMatches
```

Prefer updating canonical existing pages over creating near-duplicates. Record
candidate page paths plus their product area. Search is rate-limited, so use
2–4 precise searches rather than many broad ones.

### 3. Create a tiny sparse checkout

Use `/workspace/cloudflare-docs`. The default branch is `production`, not
`main`. Fetch commit/tree metadata and only the blobs needed for this patch:

```bash
git clone --depth=1 --filter=blob:none --sparse --no-checkout \
  --branch production \
  https://github.com/cloudflare/cloudflare-docs.git \
  /workspace/cloudflare-docs
cd /workspace/cloudflare-docs

git sparse-checkout set --no-cone \
  AGENTS.md \
  .agents/skills/contributing \
  .agents/references \
  .agents/skills/pr/SKILL.md \
  .github/pull_request_template.md
git checkout production
```

Then add only candidate pages, their nearest `index.mdx`, 2–3 useful sibling
pages, and any partials/assets that the selected pages import:

```bash
git sparse-checkout add <candidate-paths...>
```

A blobless sparse checkout is intentional: it preserves ordinary `git diff`,
commit, push, and follow-up behavior without loading the repository into the
Worker or container. Do not broaden it to all of `src/content`.

If `/workspace/cloudflare-docs` already exists (CI continuation or a resumed
turn), reuse it. Fetch the current branch and do not reclone.

### 4. Follow the docs repository's own instructions

Before editing, read in this order:

1. `/workspace/cloudflare-docs/AGENTS.md`
2. `.agents/skills/contributing/SKILL.md`
3. `contributing/references/writing-docs.md`
4. the other references that `writing-docs.md` routes this task to
5. `.agents/references/style-guide.md`
6. candidate pages and their siblings

The source PR is the technical source of truth. Do not invent availability,
plans, lifecycle state, behavior, or examples that the source PR does not
establish. The repository is public: never copy internal URLs, private context,
credentials, or secrets into files, commits, PRs, or comments.

Make the smallest coherent patch. Preserve existing page structure and voice.
Add a new page or changelog only when the docs instructions and source change
justify one.

### 5. Validate what is practical in the sparse checkout

Always run:

```bash
git diff --check
git diff --stat
git diff -- <changed-paths...>
```

Check MDX imports, frontmatter, internal links, code fences, heading order, and
examples manually against the nearby pages and repository instructions.

Do **not** expand the sparse checkout or install the full cloudflare-docs
workspace merely to run its multi-gigabyte build. Its GitHub CI is the
full-repository validator and the continuation path below repairs attributable
failures. If a narrow validation command is already available without a full
install, run it and record the result.

### 6. Branch, commit, push, and open a draft PR

Set the App identity and use the reserved branch prefix. Include the source
coordinates in the branch name; a timestamp prevents collisions:

```bash
git config user.name "agent-think[bot]"
git config user.email "agent-think[bot]@users.noreply.github.com"
BRANCH="agent-think/docs-sync-<source-owner>-<source-repo-name>-pr-<source-pr>-$(date +%s)"
git checkout -b "$BRANCH"
```

Commit only the intended docs files. Push directly to
`cloudflare/cloudflare-docs` so its deploy-preview job runs; do not create a
fork. Use the docs repository's `[Product] ...` title convention and PR template.
Open every generated docs PR as a **draft**. The requester's `sync docs`
instruction is explicit authorization for this automation to commit, push, and
open that draft; do not pause for another confirmation.

The visible summary must link the public source PR and explain which
user-facing behavior is being documented. Never mark the PR ready, request
reviewers, or merge it.

### 7. Create one source status comment

Post one substantive status comment on the source PR after the draft docs PR
exists. Include the docs PR URL, changed page paths, and that CI is running.
End it with this marker:

```html
<!-- agent-think-doc-sync-status: cloudflare/cloudflare-docs#<docs-pr> -->
```

On every continuation, find that comment and **edit it in place** via the GitHub
API. Do not add a new comment per CI attempt and do not post an acknowledgement
before a docs PR exists.

After the draft docs PR exists, call the `wake_up` tool with this exact stable
id (substitute the real docs PR number):

```text
github:workflow-run:cloudflare/cloudflare-docs:pr:<docs-pr>:workflow:CI
```

Description: `Wait for cloudflare/cloudflare-docs CI on PR #<docs-pr>`.
The private gh-app is deliberately pinned to **only**
`cloudflare/cloudflare-docs` and its `CI` workflow. It derives the same id from
the completed workflow event and reports the result through the generic wake-up
entrypoint; the registry, not the event producer, maps that action id back to
this Think session.

End the initial turn immediately after `wake_up` returns `registered`. Do not
run `gh pr checks --watch`, sleep, poll, or keep the container/DO alive. The
`workflow_run.completed` webhook wakes this session with a fresh installation
token and submits the result as a new user message on this thread.

## CI continuation

The continuation message identifies the docs PR, workflow run, conclusion,
head SHA, and repair attempt. Follow these steps exactly.

### 1. Reject stale or unrelated runs

Fetch the existing docs PR and compare its current head SHA with the event:

```bash
gh pr view <docs-pr> --repo cloudflare/cloudflare-docs \
  --json number,url,state,isDraft,headRefName,headRefOid,author,title,body
```

Stop without changing anything if:

- the PR is closed;
- the author is not `agent-think[bot]`;
- its head branch does not start with `agent-think/docs-sync-`;
- `headRefOid` differs from the workflow event's head SHA (a newer push made
  this run stale).

### 2. Successful CI

When the `CI` workflow conclusion is `success`:

- inspect current checks with `gh pr checks` for context;
- do not modify the docs branch;
- edit the source status comment to say docs CI passed and the draft is ready
  for human review;
- keep the docs PR in draft state;
- return the final structured result.

Other optional/skipped checks do not make a successful main `CI` workflow a
failure. Never merge or mark ready automatically.

### 3. Failed CI

The continuation enforces a maximum of **three failed CI runs**. If the message
says the budget is exhausted, do not push again. Edit the source status comment
with the remaining failure and workflow URL, then stop.

Otherwise inspect the failed run using Actions read permission:

```bash
gh run view <run-id> --repo cloudflare/cloudflare-docs \
  --json name,status,conclusion,url,headSha,jobs
gh run view <run-id> --repo cloudflare/cloudflare-docs --log-failed
```

The output can be large. Start with job/step metadata and retrieve only the
failed log needed to diagnose the error. Determine whether the failure is
caused by this docs patch.

If attributable and confidently fixable:

1. Reuse `/workspace/cloudflare-docs` and check out the existing branch.
2. Fetch/reset to the remote branch head if necessary.
3. Add sparse paths needed for the diagnosis, never the entire repository.
4. Make the minimum fix.
5. Run `git diff --check` and any narrow relevant validation.
6. Commit as `agent-think[bot]` and push to the same branch.
7. Edit the single source status comment with the repair attempt and new head.
8. Call `wake_up` again with the **same stable action id** for the docs PR. A
   wake-up registration is one-shot and was consumed to deliver this result.
9. End the turn. The new push starts CI and a later webhook resumes the session.

If unrelated, flaky, permission-related, or not confidently fixable, do not
change product documentation to appease it and do not rerun CI speculatively.
Update the source status comment with the diagnosis and workflow URL.

## Return the structured result

Return exactly these fields:

- `docsPrOpened` (boolean)
- `skipped` (boolean)
- `waitingForCi` (boolean)
- `ciPassed` (boolean)
- `summary` (string — one or two sentences)
- `docsPrUrl` (string, optional)
- `docsBranch` (string, optional)
- `sourceStatusCommentUrl` (string, optional)
- `repairAttempt` (number, optional)
