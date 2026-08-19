---
"agents": minor
"@cloudflare/think": minor
---

Remove the experimental Agent Skills script runner, the `run_skill_script` tool, runner types, Think's `getSkillScriptRunner()` hook, and the `agents/skills/compile` entry point. Skills now provide on-demand instructions and readable resources only. Applications that need execution should expose it through an explicit tool.
