---
"agents": minor
"@cloudflare/think": patch
---

Experimental: add `Context` to `agents/context`, which binds context blocks to a session and records the system prompt and each delivered change in the transcript, so a change is sent once and the prompt cache holds. `ContextBlocks` no longer keeps a frozen prompt (`freezeSystemPrompt`, `refreshSystemPrompt`, `reminder`, and the prompt store move to `Context`), and Think's context runs on `Context`. See [Context](https://github.com/cloudflare/agents/blob/main/docs/agents/context.md).
