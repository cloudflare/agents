---
"agents": minor
"@cloudflare/think": minor
---

Experimental: Think's context is now recorded on the session, so each turn opens with the exact system prompt it was sent before and a changed `whenChanged: "remind"` block is sent once, where it was first delivered, instead of moving every turn. What changed in `agents/context`: `freezeSystemPrompt`, `refreshSystemPrompt` and `reminder` moved from `ContextBlocks` to the new experimental `Context`, and `ContextBlocks` no longer takes a prompt store. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).
