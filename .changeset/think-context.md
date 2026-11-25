---
"agents": minor
"@cloudflare/think": minor
---

Experimental: Think's context is recorded on the session. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).

- Each turn opens with the exact system prompt it was sent before, and a changed `whenChanged: "remind"` block is sent once, where it was first delivered, instead of moving every turn.
- What changed in `agents/context`: `freezeSystemPrompt`, `refreshSystemPrompt` and `reminder` moved from `ContextBlocks` to the new experimental `Context`, and `ContextBlocks` no longer takes a prompt store. `Context`'s `promptStore` option is read only.
- A block the model writes with `set_context` is not sent back to it; one your code writes with `setBlock()` is sent once, after the next user message.
- `withCachedPrompt()` stores are only read now, for prompts frozen before this release.
