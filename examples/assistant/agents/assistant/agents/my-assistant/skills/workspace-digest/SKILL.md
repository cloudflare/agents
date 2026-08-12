---
name: workspace-digest
description: Summarize the files saved in this assistant's shared workspace. Use when the user asks what is in their workspace, for a file inventory, or a digest of saved work.
---

# Workspace digest

Produce a concise inventory of the files saved in this assistant's shared
workspace (the same workspace every chat under this user shares).

## Process

1. Read `references/format.md` for the preferred response format.
2. Use the workspace `find` tool with `**/*` to inventory the workspace. Narrow
   the glob when the user asks about a specific directory.
3. Use the workspace `list` tool on notable directories when file sizes or
   directory contents would make the summary more useful.
4. Summarize the result: how many files were found and which ones are notable.
5. Offer to open or read any specific file the user is interested in.

## Output format

Keep the digest short: a markdown list of notable files plus a one-line
summary. Only print the full listing if the user asks for it.
