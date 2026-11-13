---
"agents": patch
---

`agents/harness/opencode` and `agents/models/opencode` now need opencode 2.2.3 or later (peer range `^2.2.3`), because `agents/models/opencode` now supplies its provider through OpenCode's `sdk` hook and no longer borrows `@ai-sdk/vercel`, which OpenCode stopped bundling in 2.2.1. This is a one-way door: once opencode 2.2.0 or later has run, file attachments and file tool results are stored in a `blob` table, and from 2.2.4 background job markers are stored in a `job` table, and older releases can't read either. See [the OpenCode harness example](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/README.md).
