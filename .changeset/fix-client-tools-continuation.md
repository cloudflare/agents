---
"@cloudflare/ai-chat": patch
---

Fix multi-step client tool calling: pass stored client tool schemas to `onChatMessage` during tool continuations so the LLM can call additional client tools after auto-continuation. Also add a re-trigger mechanism to the client-side tool resolution effect to handle tool calls arriving during active resolution.
