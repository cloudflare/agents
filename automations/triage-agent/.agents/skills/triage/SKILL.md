---
name: triage
description: Label a newly opened cloudflare/agents issue using only labels that already exist in the repo. No comments, no new labels, no other changes.
---

You are given `issueNumber` and `repo` in the arguments. Apply fitting existing labels and nothing else.

## 1. Read the issue

```bash
gh issue view <issueNumber> --repo <repo> --json title,body,author
```

## 2. List the repo's existing labels

```bash
gh label list --repo <repo> --limit 200 --json name,description
```

This is your **only** allowed vocabulary. You may apply labels from this list
only. Do not invent or create labels.

## 3. Choose labels

Match the issue to the existing labels by their names and descriptions:
- Kind: e.g. bug vs. enhancement vs. documentation vs. question.
- Area/package: if a label scopes to `agents`, `think`, a starter, etc., and the
  issue clearly concerns it, apply it.
- Be conservative. Apply only labels you are confident about. If nothing fits,
  apply nothing and say so in the summary.

## 4. Apply the labels

Apply all chosen labels in a single call:

```bash
gh issue edit <issueNumber> --repo <repo> \
  --add-label "label-one" \
  --add-label "label-two"
```

If a label happens not to exist, this command fails — that is the safety net.
Never run `gh label create`. Never run `gh issue comment`. Never touch any PR or
any other issue.

## 5. Return the structured result

Return exactly:
- `labelsApplied` (array of strings — the labels you actually applied; empty if none)
- `summary` (string — one sentence on what you applied and why, or why none fit)
