---
"agents": minor
"@cloudflare/think": minor
---

Context blocks can opt into `whenChanged: "remind"`. When such a block changes after the system prompt was frozen, `ContextBlocks.reminder()` returns its current value for the host to send after the cached prefix, and the frozen prompt stays intact until `refreshSystemPrompt()` promotes it. Think adds the reminder to the last user message of each model request without persisting it.
