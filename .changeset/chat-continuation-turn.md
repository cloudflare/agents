---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

An auto-continuation turn runs, fails and settles one way in `AIChatAgent` and `Think`: a stop reaches it while it waits in the queue; it never continues a reply that already went on to its answer, but does continue one whose tool call and text share a step; a tool result that arrives while a continuation fails or its stream errors still gets its own continuation; a failed request or continuation records the terminal status before the error frame, and `onChatResponse` for a failed continuation runs after the turn left the queue; `AIChatAgent` emits `message:error` for a failed continuation; a `Think` continuation gets context-overflow recovery; a `Think` approval of a paused execution continues like any other result, so one that arrives after the conversation moved on is stored and read by the next turn without starting a turn of its own; `waitForIdle` and `waitUntilStable` no longer resolve between a `Think` continuation firing and its turn; a stopped continuation that throws is not logged as a failure; a tab that watches a `Think` tool continuation draws it as the message it is stored in, not twice; and a dropped continuation emits `chat:continuation:dropped` with the reason. See [Observability](https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md).
