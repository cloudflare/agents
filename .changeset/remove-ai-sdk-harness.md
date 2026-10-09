---
"agents": minor
---

Breaking (experimental): remove `AiSdkHarness` and the `agents/harness/ai-sdk` entry point, including `createSendMessageTool`; use `ThinkHarness` instead. Its AI SDK message conversions move to `agents/experimental/channels/projections/ai-sdk`. See [Channels](https://github.com/cloudflare/agents/tree/main/packages/agents/src/experimental/channels/docs/CONTEXT.md).
