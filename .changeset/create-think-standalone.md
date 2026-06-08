---
"@cloudflare/think": patch
"create-think": patch
---

Decouple `create-think` from `@cloudflare/think` for fast project starts.

`create-think` is now fully standalone — it owns the starter-template scaffolding logic and depends only on `tiged` + `yargs`, so `npm create think` no longer installs the entire framework just to copy a template.

`think init` now has two modes:

- **New project** — when `--template` is given, or when run outside an existing npm project, it delegates to `create-think` to fetch a complete starter template.
- **Augment in place** — when run inside an existing npm project with no `--template`, it adds Think framework files (agent, Vite/Wrangler config, generated types) and merges dependencies into the current project.

The internal `@cloudflare/think/cli` export has been removed (its scaffolding logic now lives in `create-think`).
