---
"@cloudflare/think": minor
---

Think reads Agent Skills from files. Return `skills.workspace(this.workspace)` from `getSkills()` to use skills stored under `/workspace/.agents/skills`; Think lists sources before every turn, so skills written, edited, or deleted there take effect on the next turn.

Breaking: `skillWorkspace` is removed. Think no longer copies sources into the Workspace. The extension context block type `"skill"` and `ExtensionSkillBridge` are removed. `SkillWorkspaceSeedOptions` is no longer exported.
