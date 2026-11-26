---
"agents": minor
---

Experimental harnesses and Channels.

- Remove the experimental `AiSdkHarness` (`agents/harness/ai-sdk`), with its `createSendMessageTool` and AI SDK conversion exports. Use Think or the Pi harness; to serve an agent through Channels, use `ThinkHarness` from `agents/harness/think`, which takes the same `model` and `tools`; existing `AiSdkHarness` transcripts stay in storage and are not carried over.
- `ThinkHarness` no longer calls a tool's `onInputStart`, `onInputDelta` or `onInputAvailable`, and warns once for each tool that has one.
- `ThinkHarness` offers a session's client tools after its own, as `Think` does.
- `ThinkHarness` resolves its tools once per turn attempt, so a change to the tool set applies from the next attempt, not between steps. A cut-off call whose tool the new attempt no longer has is answered with a tool error, where the turn used to wait for a client that would never answer (#3194).
- `ThinkHarness` tells the model once when a turn's tools differ from the previous turn's: which were added, which are gone (not to be called) and which changed. The notice goes after that turn's user message, in a session with a context.
- `ThinkHarness` emits a `prefix-changed` session event before a model call whose prefix differs from the session's previous call, with the causes: the tools sent, the system prompt sent, or history compacted, edited or deleted around the harness.
- `ThinkHarness` refuses a client tool result from anyone but the participant who started the turn (`not_owner`).
- The harness store no longer corrupts long log entries containing emoji (#3054).
- Channels: a message surface may carry a `key` that stays the same across messages of one place; an inbound email's surface carries its thread root, so a thread that writes twice is one surface answered at its latest message.
- Channels `applyChunks` keeps a pending approval when the tool's input arrives late (#3145).
