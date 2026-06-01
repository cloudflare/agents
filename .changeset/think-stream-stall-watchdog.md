---
"@cloudflare/think": minor
"agents": patch
---

Add an opt-in inactivity watchdog for the streaming read loop, so a hung provider/transport surfaces a terminal error instead of an infinite spinner.

Previously, if a model stream parked without ever throwing — no chunk, no error, no `done` — the chat read loop would wait forever and the client would spin indefinitely. There was no detection for a silently hung turn (only recovery-path `stable_timeout`, which guards recovery scheduling, not a live stream).

Set `chatStreamStallTimeoutMs` on a Think subclass to arm it: if no UI-message-stream chunk arrives within that window, the watchdog aborts the turn and the loop exits with a terminal stream error (routed through `onChatError` with `stage: "stream"`), emitting a new `chat:stream:stalled` observability event.

It is **off by default** (`0`) and applies to both the WebSocket turn loop and the `chat()` / sub-agent callback loop. Note it measures the gap _between_ stream chunks, which includes server-side tool execution time (no chunks flow while a tool runs) — set it comfortably above your slowest model time-to-first-token and slowest tool, or you will abort healthy long turns. A good starting point is `120_000`.
