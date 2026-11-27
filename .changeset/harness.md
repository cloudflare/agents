---
"agents": minor
---

Experimental harnesses and Channels.

- Remove the experimental `AiSdkHarness` (`agents/harness/ai-sdk`), with its `createSendMessageTool` and AI SDK conversion exports. Use Think or the Pi harness; to serve an agent through Channels, use `ThinkHarness` from `agents/harness/think`, which takes the same `model` and `tools`; existing `AiSdkHarness` transcripts stay in storage and are not carried over.
- `ThinkHarness`: `recovery.maxAttempts` (default 10) counts attempts without progress, `recovery.backoffMs` is removed, a cut-off tool reruns only if marked `recovery: "rerun"`, and tools' `onInputStart`, `onInputDelta` and `onInputAvailable` are no longer called.
- `ThinkHarness` tells the model when its tools changed, emits `prefix-changed`, and takes client tool results only from the turn's owner.
- `ThinkHarness` runs on AI SDK 6, no longer hangs on an in-band stream error, and no longer corrupts long log entries with emoji (#3054).
- Channels: a surface `key` groups one place's messages, and a reset no longer posts an answer twice (#3145).
