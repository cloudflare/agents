---
"@cloudflare/think": patch
---

Chat continuation no longer fails on models that reject assistant-prefill.
Continuing a partial assistant turn (e.g. after a deploy interrupts a stream)
replayed a transcript whose final message was that partial assistant message.
Modern chat models reject a request ending in an assistant message — Anthropic
Claude 4.6+ returns a 400 ("This model does not support assistant message
prefill. The conversation must end with a user message.") — so the continuation
threw and the turn was left interrupted. Think now appends an ephemeral user
"continue" checkpoint whenever a model request would otherwise end in an
assistant message, so continuation works across providers. The checkpoint
shapes only the model request and is never persisted to the transcript.
