---
"@cloudflare/think": minor
---

Breaking: Think reloads `getSkills()` sources every turn, so `skills.workspace(this.workspace)` picks up skills written to `/workspace/.agents/skills`; an overridden `getSystemPrompt()` now always renders above context blocks instead of being dropped once any block exists; skill catalog changes reach the model as a context reminder rather than rebuilding the cached system prompt; `skillWorkspace` and the extension `"skill"` context block type are removed. See [Agent Skills](https://developers.cloudflare.com/agents/skills/).
