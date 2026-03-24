---
"@cloudflare/shell": minor
---

feat(shell): add isomorphic-git integration for workspace filesystem

New `@cloudflare/shell/git` export with pure-JS git operations backed by the Workspace filesystem. Includes `createGit(filesystem)` for direct usage and `gitTools(workspace)` ToolProvider for codemode sandboxes with auto-injected auth tokens.
