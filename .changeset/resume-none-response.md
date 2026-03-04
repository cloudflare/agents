---
"@cloudflare/ai-chat": patch
---

Server now responds with `CF_AGENT_STREAM_RESUME_NONE` when a client sends `CF_AGENT_STREAM_RESUME_REQUEST` and no active stream exists. This collapses the previous 5-second timeout to a single WebSocket round-trip, fixing the UI stall on every conversation open/switch/refresh when there is no active stream.
