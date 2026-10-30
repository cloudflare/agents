---
"agents": patch
---

`agents/harness/opencode` and `agents/models/opencode` now need opencode 2.2.3 or later (peer range `^2.2.3`): `agents/models/opencode` supplies its provider through OpenCode's `sdk` hook instead of borrowing `@ai-sdk/vercel`, which OpenCode stopped bundling in 2.2.1. One-way door: opencode 2.2.0 and later move file attachments and file tool results into a blob table that releases before 2.2.0 cannot read. See [the OpenCode harness example](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/README.md).
