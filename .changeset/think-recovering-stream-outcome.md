---
"@cloudflare/think": patch
---

Record the close outcome on Think's chat streams, so a resume that replays a stream closed for a scheduled recovery reports `recovering` (and an aborted stream reports `aborted`) instead of `completed`.

A connection that was offered a stream but never acknowledged it (for example `useAgentChat` with `resume: false`) now gets the stream's terminal frame and later broadcasts on every path, including `chat()` RPC turns.
