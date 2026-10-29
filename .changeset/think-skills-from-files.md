---
"@cloudflare/think": minor
---

Breaking: Think reloads `getSkills()` sources every turn, so `skills.workspace(this.workspace)` picks up skills written to `/workspace/.agents/skills`; `skillWorkspace` and the extension `"skill"` context block type are removed. See [Agent Skills](https://developers.cloudflare.com/agents/skills/).
