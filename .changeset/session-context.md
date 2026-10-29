---
"agents": minor
"@cloudflare/think": patch
---

Declare context blocks on a session with `withContext()`. The session stores the frozen system prompt by default, stores blocks without a provider in SQLite, and refreshes the prompt after `compact()` and `clearMessages()`. Think's session context methods are no longer deprecated. See [Context](https://github.com/cloudflare/agents/blob/main/docs/agents/context.md).
