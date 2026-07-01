# triage-agent

Auto-labels newly opened issues in `cloudflare/agents` using only the repo's
existing labels.

> **Note:** unlike the other agents, this agent has **no sandbox filesystem**,
> so this file is developer documentation — it is _not_ loaded as agent context
> at runtime. The agent's behavior lives entirely in `.flue/workflows/triage.ts`
> (`instructions`) and its typed tools.

## Locked-down by design

Triage runs on **untrusted input** (any issue body from anyone), so it is
hardened against prompt injection:

- **No shell, no filesystem tools.** `.flue/lib/locked-sandbox.ts` provides a
  `SandboxFactory` whose tool factory returns `[]`, replacing Flue's default
  workspace tools. There is no `bash` for an injected instruction to run
  `env` / `gh auth token`, and no `edit`/`write` to tamper with anything.
- **Three typed tools only** (`.flue/lib/github-tools.ts`): `view_issue`,
  `list_labels`, `apply_labels`. The GitHub token, repo, and issue number are
  read from `process.env` _inside_ each tool — never exposed to the model and
  never model-selectable.
- **Cannot escalate.** `apply_labels` validates against existing labels (so the
  model cannot create labels), and there is simply no tool to comment, delete,
  or read another issue. The workflow grants only `issues: write`.

## Files

- `.flue/workflows/triage.ts` — agent definition (model, locked sandbox, tools,
  inlined instructions) + the workflow.
- `.flue/lib/locked-sandbox.ts` — the no-shell/no-fs sandbox.
- `.flue/lib/github-tools.ts` — the three typed GitHub tools.
