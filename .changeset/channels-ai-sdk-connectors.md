---
"agents": minor
---

Add `AiSdkHarness` from the new `agents/harness/ai-sdk` entry point, which runs each message with `streamText` and keeps sessions and transcripts in the Durable Object, so `Channels.forHarness` can serve an AI SDK model. The same entry point exports the AI SDK message conversions it is built on and `createSendMessageTool`, an AI SDK tool that sends a message to a surface through the gateway.
