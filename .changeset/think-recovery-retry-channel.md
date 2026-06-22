---
"@cloudflare/think": patch
---

Fix: a recovered pre-stream **retry** turn now re-applies per-channel policy.

`continueLastTurn` already re-resolved the channel from the persisted user
message (`metadata.channel`) so a recovered partial turn re-applied its
channel's instructions / tool narrowing. The pre-stream retry path
(`_retryLastUserTurn`, used by `_chatRecoveryRetry`) admitted the recovered turn
without re-resolving the channel, so an interrupted-before-streaming turn was
retried with the default policy instead of the channel's — even though the
`metadata.channel` stamp survived. It now re-resolves and re-applies the channel
on both recovery paths, matching the documented invariant.
