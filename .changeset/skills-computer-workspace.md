---
"agents": minor
---

Agent Skills now read and write a `@cloudflare/computer` Workspace through `workspace.fs`. `SkillWorkspace` takes that shape for both `seedWorkspace()` and `skills.runner({ workspaceInstance })`, and the default projection root is `/workspace/.agents/skills`. Relative paths in skill scripts resolve against `/workspace`.

Breaking change: `LegacySkillWorkspace`, `ComputerSkillWorkspace`, and `SkillProjectionWorkspace` are removed, and a `@cloudflare/shell` Workspace is no longer accepted.
