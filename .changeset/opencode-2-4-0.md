---
"agents": patch
---

`agents/harness/opencode` and `agents/models/opencode` now need opencode 2.2.3 or later (peer range `^2.2.3`, tested with 2.4.0): `agents/models/opencode` supplies its provider through OpenCode's `sdk` hook instead of borrowing `@ai-sdk/vercel`, which OpenCode stopped bundling in 2.2.1, and the harness uses `experimental.session.wait` and `experimental.session.log` in place of the deprecated `sessions.wait` and `sessions.log`. This is a one-way door: from opencode 2.2.0 session media is stored as references into a `blob` table, and from 2.2.4 background job markers move from `kv` to a `job` table, so an object can't go back to an older opencode release once a newer one has run. See [the OpenCode harness example](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/README.md).
