---
"@cloudflare/think": minor
---

Generalize the messenger runtime into a public channel surface. Add `configureChannels()` and `ChannelDefinition` (web, voice, messenger, and custom channels) wrapping `getMessengers()`, a no-turn `deliverNotice()` with `informModel`, additive `DeliveryTag` (kind + turnEnded) on messenger snapshots, per-channel policy (instructions, tool-narrowing, `maxTurns`) applied as overridable defaults, turn-scoped channel context threaded through `runTurn` (persisted for recovery), reply-attachment rendering at delivery, and `channel:*`/`notice:*` observability events.
