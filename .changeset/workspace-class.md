---
"agents": patch
---

Add `Workspace` class — durable file storage for any Agent with hybrid SQLite+R2 backend and optional just-bash shell execution. Includes `BashSession` for multi-step shell workflows with persistent cwd and env across exec calls, and `cwd` option on `bash()`. Usage: `new Workspace(this, { r2, r2Prefix })`. Import from `agents/experimental/workspace`.
