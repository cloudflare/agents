---
name: release-notes
description: Draft short release notes from a list of changes. Use when the user asks for changelogs, release notes, or a concise product update.
---

# Release Notes

Turn implementation details into user-facing release notes.

## Process

1. Identify the user-facing outcome.
2. Group related implementation details into one bullet.
3. Avoid internal file names unless the user asks for engineering notes.
4. Keep the tone factual and concise.

When the user provides a rough list of changes, run
`scripts/format-release-notes.ts` with `{ "changes": [...] }` to create a first
draft, then polish the wording for the user's audience. The TypeScript script
demonstrates reading `references/style-guide.md` with `node:fs`.

If the user asks to inspect or echo the raw script input, run
`scripts/count-changes.sh`; it demonstrates Bash skill scripts reading
`/input.json`.

If the user asks for a quick count and compact summary of changes, run
`scripts/summarize-changes.py` with `{ "changes": [...] }`; it demonstrates
Python skill scripts reading the same `/input.json` and `/context.json` files.

## Output format

Use this structure:

```md
## Summary

- One to three bullets describing what changed.

## Notes

- Optional caveats, migration details, or follow-up work.
```

If the input is too vague, ask for the target audience and the release scope.
