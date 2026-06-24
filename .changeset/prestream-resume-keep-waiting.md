---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix AI SDK `status` getting stuck after a reconnect that races a turn's
pre-stream window (#1784).

A turn is "accepted but pre-stream" while it is queued, debouncing, or awaiting
async setup before its resumable stream starts. A client that connected or sent
a `STREAM_RESUME_REQUEST` in that window was answered with `STREAM_RESUME_NONE`
("nothing to resume"), so its short resume probe resolved `null` and AI SDK
`status` settled on `ready` even though the server went on to stream — leaving
the UI unable to render the in-flight turn until a full remount.

This adds a shared `PreStreamTurns` tracker (`agents/chat`) and a new
server→client `cf_agent_stream_pending` frame:

- The resume handshake now parks resume requests that arrive during the
  pre-stream window and emits `STREAM_PENDING` ("keep waiting") instead of
  `STREAM_RESUME_NONE`, then flushes parked connections into the normal
  `STREAM_RESUMING` handshake once the stream actually starts (and releases them
  with `STREAM_RESUME_NONE` if the turn is superseded/cleared before streaming).
- On `STREAM_PENDING` the client transport extends its resume probe from the
  5s fast-path to a 60s backstop so the probe stays open across the gap.
- `useAgentChat` re-probes the stream on a transparent socket reopen (e.g. a
  1006 reconnect that does not remount the component) so `status` recovers.
- Continuation affinity is relaxed via an optional `isConnectionPresent` host
  hook so a transparent reconnect (whose connection id changed) can resume a
  continuation whose original owner connection is gone.

Wired into both `AIChatAgent` and `@cloudflare/think`.

The pre-stream tracker is in-memory only; it is hibernation-safe because a turn
in its pre-stream window is an unresolved message-handler promise that pins the
Durable Object in memory, so eviction only happens once a stream is durably
recorded (and resumes via `ResumableStream`) or the turn has finished. Skipped
turns (supersede/generation change) settle without releasing parked
connections, so a client parked during the window survives onto the successor
turn instead of being cut loose by a premature `STREAM_RESUME_NONE`.
