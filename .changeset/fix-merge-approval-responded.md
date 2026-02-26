---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): preserve server tool outputs when client sends approval-responded state

`_mergeIncomingWithServerState` now treats `approval-responded` the same as
`input-available` when the server already has `output-available` for a tool call,
preventing stale client state from overwriting completed tool results.
