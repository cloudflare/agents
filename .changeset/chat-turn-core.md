---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` now run on one shared turn core and follow the same rules: a cut-off reply is stored with its unanswered tool calls settled, and `Think` no longer waits on a dead server tool call an older release stored; a request's tools apply when its turn starts; a request cancelled in the queue never runs; a tool result that arrives while the reply is being stored is kept; a client request never shortens a stored reply or writes back history another tab cleared; and overrides of `_enqueueInteractionApply` and `hasPendingClientInteraction` are honored.
