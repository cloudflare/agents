---
"agents": minor
---

Experimental harnesses and Channels.

- Remove the experimental `AiSdkHarness` (`agents/harness/ai-sdk`), with its `createSendMessageTool` and AI SDK conversion exports. Use Think or the Pi harness; to serve an agent through Channels, use `ThinkHarness` from `agents/harness/think`, which takes the same `model` and `tools`; existing `AiSdkHarness` transcripts stay in storage and are not carried over.
- `ThinkHarness`: `recovery.maxAttempts` (default 10) counts attempts without progress, `recovery.backoffMs` is removed, a cut-off tool reruns only if marked `recovery: "rerun"`, and tools' `onInputStart`, `onInputDelta` and `onInputAvailable` are no longer called.
- `ThinkHarness` tells the model when its tools changed, answers a cut-off call to a removed tool with an error instead of waiting, and emits `prefix-changed` (#3194).
- `ThinkHarness` takes client tool results only from the turn's owner, runs on AI SDK 6, no longer hangs on an in-band stream error, and no longer corrupts long log entries with emoji (#3054).
- Channels: a surface `key` groups one place's messages, and a reset no longer double-posts an answer (#3145).
- Channels: a response cut off while a tool's input was still arriving is replaced by its rerun, not posted as cut off.
- ThinkHarness retries a turn after a platform transient (a lost connection, a storage reset, an error marked retryable) within its recovery budget, instead of ending it unanswered. A turn whose recovery gives up is finished like any given-up reply: its open tool calls fail and its stream is dropped. An aborted operation's inspection names the reply it kept (`messageId`).
