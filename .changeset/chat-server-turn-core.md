---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`saveMessages`, `continueLastTurn` and the recovery retry in `AIChatAgent` and `Think` run through one shared function: a turn stopped before it starts stores nothing, never calls the model and fires no `onChatResponse`; a chat clear gives `skipped`; the turn runs with the tools and body stored when it starts; `abortAllRequests()` stops every reply, queued or waiting on `onChatMessage`; `Think` recovers a context overflow on continued and retried turns too, reporting a turn stopped meanwhile as `aborted`; a turn whose reply finished stays `completed` when the chat is cleared while `onChatResponse` runs; a continuation that ends before the model returned a reply leaves a scheduled recovery in place; a recovered or agent-tool turn's tools and body are never written to the chat's stored request context; an `aborted` result carries `reason: "stopped"` or `"interrupted"` (cut off and handed to recovery, so the reply may still arrive); and in `Think` an overflow with no retry left, or a turn stopped at one, fires `onChatResponse` once on every path.
