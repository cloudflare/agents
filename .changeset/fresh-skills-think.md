---
"@cloudflare/think": minor
"agents": minor
---

Add a framework-agnostic Agent Skills engine at `agents/skills`: skill sources (`fromManifest`, R2), a `SkillRegistry` that produces a catalog prompt and AI SDK activation tools (`activate_skill`, `read_skill_resource`, `run_skill_script`), binary-safe resource reads, and qualified cross-skill resource paths. Bundled skills are imported through the Agents Vite plugin with the `agents:skills` specifier (defaulting to a `./skills` directory), typed via ambient declarations shipped from `agents`. `@cloudflare/think` re-exports the engine as `skills` and wires `getSkills()` into the turn; any AI SDK caller (including `@cloudflare/ai-chat`) can build a `SkillRegistry` directly.

Skill loading is resilient: duplicate or failing sources are skipped with a warning (first source wins) instead of throwing. Optional, experimental script execution (`skills.runner`) runs function-style JavaScript/TypeScript (`export default run(input, ctx)` with `ctx = { skill, files, workspace, tools, output }`) plus path-based Python and Bash, all behind a single capability and permission bridge.
