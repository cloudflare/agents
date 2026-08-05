---
"agents": patch
---

fix(chat): batch replayed chunks on resume so long turns don't trip React's update depth guard

Resuming a stream replayed every stored chunk as its own frame, and the
transport forwarded each one into the UI-message stream individually. A long
turn's replay updated chat state once per chunk, which outpaced React's commit
loop and threw "Maximum update depth exceeded" — surfacing as a false terminal
`status: "error"` for a turn the server had completed, with the replayed text
visibly re-typing beforehand.

Both transport-owned resume paths now collect `replay: true` chunks in a short
coalescing window and merge consecutive deltas of the same part. The window
closes at the end of the event-loop turn that opened it, or earlier at a replay
boundary (`replayComplete`, `done`, or the first live chunk). Applying a
replayed prefix is now proportional to the number of message parts rather than
the number of chunks.

The window is bounded to a single turn on purpose: a burst spread over several
turns cannot trip React's guard, and holding replayed chunks any longer would
reorder them against the hook's own replay bookkeeping, which repairs a second
replay of the same turn (#1733) by inspecting already-applied messages.

Cross-part ordering is unchanged, deltas carrying `providerMetadata` are kept
whole, and an errored resumed turn still delivers its replayed content before
the terminal error.
