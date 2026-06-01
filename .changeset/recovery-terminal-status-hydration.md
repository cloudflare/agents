---
"@cloudflare/think": patch
---

Interrupted/failed chat turns are no longer silently "frozen" for clients that
reconnect after the failure. The terminal `MSG_CHAT_RESPONSE` broadcast (on a
turn error or exhausted recovery) is transient — a client disconnected at that
moment (e.g. during a deploy / WebSocket reconnect storm) misses it, and on
reconnect `onConnect` previously replayed only the current messages with no
terminal signal, so the turn appeared stuck with no completed response and no
error. Think now persists a durable record of the last terminal turn and
replays it on connect, so a reconnecting client learns the turn failed. The
record is cleared when a later turn completes; benign recovery skips (e.g.
`conversation_changed`, where a newer turn owns the UI) are intentionally not
surfaced.
