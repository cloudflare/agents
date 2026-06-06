---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Surface a terminal chat-recovery outcome to clients that reconnect after it ended (#1645).

When a durable chat turn exhausted recovery (e.g. during a deploy/reconnect storm) while no client was connected, the terminal error was only broadcast transiently, so a client that connected afterward never learned the turn failed and the conversation appeared frozen. The outcome is now persisted durably and replayed over the resume handshake on the next reconnect — `STREAM_RESUMING` → `STREAM_RESUME_ACK` → terminal error frame on the resumed stream — which is the only path that surfaces as `useAgentChat`'s `error` on the real client. (A bare replayed frame is dropped by the client because it never reaches a transport stream reader.) The record is cleared once a later turn supersedes it — on a new client request, and also when any later turn ends in a non-error outcome (completed or aborted, including turns driven server-side via `saveMessages`), so a stale exhaustion can never replay after the conversation has recovered. Terminal non-exhaustion errors (e.g. a provider 500) are now durably recorded too, not just transiently broadcast, so they also replay to a reconnecting client.

`@cloudflare/think` previously recorded the outcome durably but only replayed it as a bare on-connect frame (dropped by the client); it now uses the same resume-handshake delivery.
