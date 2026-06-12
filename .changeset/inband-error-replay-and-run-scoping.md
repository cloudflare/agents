---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix the two remaining #1575 gaps in how in-band stream errors (`{type: "error", errorText}` chunks inside an otherwise-healthy provider stream) are observed after the fact.

**Errored-stream replay (partial content was lost on reconnect).** A client reconnecting after an in-band error received the terminal error frame (#1645) but not the content the model streamed before the error — the replay path only served `status = 'completed'` streams, so an errored stream's buffered chunks were unreachable, and the server pushes no messages on connect. `ResumableStream` gains `replayErroredChunksByRequestId`, and the resume-ACK terminal replay (`_replayTerminalOnAck` in both AIChatAgent and Think) now replays the errored stream's stored chunks before the `done: true, error: true` frame, so a reconnecting client observes the same sequence a live client did. No wire-format or schema changes: replayed chunks reuse the existing `replay: true` frame shape and the error text still comes from the durable terminal record.

**Agent-tool error attribution (cross-run contamination).** When an in-band error frame was broadcast on a child agent and the active run was unknown, the error was stamped onto every tailed run — so an unrelated turn's failure (or one of several overlapping runs) could mark healthy runs as `error`, and capture depended on a tailer being attached at the right moment. Frames are now attributed by the request id they carry: each agent-tool run is bound to its turn's request id when the turn starts (persisted on the run row at start rather than at terminal, so attribution survives a DO restart mid-run), and only the owning run's error/progress state is updated. Frame inspection also no longer requires an attached tailer, so error capture is independent of tailer timing.
