---
"create-think": patch
"@cloudflare/think": minor
---

`create-think` now prompts for a starter template when `--template` is omitted (and falls back to `basic` when stdin is non-interactive). `npm create think` and `think init` initialize a git repository — skipping cleanly when the target is already inside one — and scaffold projects with Oxlint/Oxfmt config plus a `check` script. Removes the unused declarative `agent()` framework helper and the identity helpers (`defineMessengers`, `defineScheduledTasks`, `defineChannels`) in favor of class-based agents and typed object returns.
