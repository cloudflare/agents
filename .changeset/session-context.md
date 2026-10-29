---
"agents": minor
"@cloudflare/think": patch
---

Add `Context` to `agents/context`: context blocks bound to a session, which record the system prompt and each delivered change in the transcript so requests extend each other and the prefix cache holds. `ThinkHarness` takes a `context` option, and Think's context now runs on it. See [Context](https://github.com/cloudflare/agents/blob/main/docs/agents/context.md).
