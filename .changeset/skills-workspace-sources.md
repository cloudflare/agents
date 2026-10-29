---
"agents": minor
---

Breaking: `agents/skills` now loads Agent Skills from Computer Workspace files (`workspace()`), R2 (`r2()`), or code (`manifest()`), checks `SKILL.md` against the Agent Skills spec, and replaces `SkillRegistry` with `loadSkillCatalog()` and `createSkillTools()` (from `agents/skills/tools/ai-sdk`); `SKILL.md` is parsed strictly on every read, and activating an invalid skill returns its validation error as a tool error; `runner()` moved to `agents/skills/runner`; the `agents:skills` Vite import and `agents/skills/compile` are removed. See [Agent Skills](https://developers.cloudflare.com/agents/skills/).
