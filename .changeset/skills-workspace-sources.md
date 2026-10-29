---
"agents": minor
---

`agents/skills` loads Agent Skills from files. Breaking for code that uses `agents/skills` directly.

- `skills.workspace(workspace, { root })` reads skills from a Computer Workspace, by default `/workspace/.agents/skills`. It reads the files on every listing, so added, edited, or deleted skills take effect the next time the catalog loads.
- `parseSkill()` follows the [Agent Skills spec](https://agentskills.io/specification): `name` must be lowercase letters, digits, and hyphens and match its directory, `description` is required, and `compatibility`, `metadata`, and `allowed-tools` are checked. It returns a result instead of `null`. Unknown frontmatter keys are kept in `extraFields`.
- `SkillSource` is now `list()` and `readResource()`, returning results with typed errors. Invalid skills are listed as diagnostics instead of being dropped.
- `loadSkillCatalog()` and `createSkillTools()` replace `SkillRegistry`. `createSkillTools()` is exported from `agents/skills/tools/ai-sdk`, so `agents/skills` no longer imports `ai` or `zod`.
- `skills.manifest()` replaces `skills.fromManifest()`, which stays as a deprecated alias. Entries no longer take `fingerprint`, `kind`, `rawContent`, or `version`.
- `skills.r2()` drops the `fingerprint` option.
- The `agents:skills` Vite import, `agents/skills/compile`, and `skills-module.d.ts` are removed. `esbuild` is no longer a runtime dependency.
- The pi harness `skills()` extension uses the same catalog as Think.
- `skills.runner()` no longer compiles TypeScript; store self-contained JavaScript.
