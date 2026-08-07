---
"@cloudflare/think": minor
"agents": minor
---

Extract the existing Shell storage, snapshot Bash, and codemode state behavior into `@cloudflare/think/workspace-legacy`. Think now consumes a narrow filesystem and runtime contract while the legacy workspace remains the default.

Allow skill script runners to consume Computer-shaped workspaces directly while preserving the previous direct-method workspace interface.
