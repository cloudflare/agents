---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix duplicated assistant text parts when a stream resume is replayed twice (#1733).

The server intentionally sends `CF_AGENT_STREAM_RESUMING` for the same request from both `onConnect` and its `CF_AGENT_STREAM_RESUME_REQUEST` handler. When both offers reached the `useAgentChat` fallback path (e.g. the transport's resume handshake had already timed out), the client ACKed both, the full chunk buffer was replayed twice into the same accumulator, and the streaming reply rendered as two stacked text blocks until refresh.

- `useAgentChat` now fallback-ACKs a given resume offer at most once per socket (reset on close/reconnect). A repeated offer is still handed to a waiting transport resume handshake first, so a fallback-observed stream can become transport-owned. It also resets the matching trailing assistant message on **every** replayed non-continuation `start`, not only while the resume request id is still pending.
- The shared broadcast stream state machine re-initializes its accumulator on a replayed `start`, making replay idempotent under any number of replays.
- Replay frames now carry `continuation: true` for continuation streams (persisted in stream metadata and restored after hibernation), so a replayed continuation appends to the existing assistant message instead of being mistaken for a fresh turn.
