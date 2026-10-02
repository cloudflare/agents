---
"agents": minor
---

Add `Channels` to `agents/experimental/channels`: a Lifecycle capability that serves an agent harness's sessions as conversations to every surface that joins them, with durable, resumable responses on `Streams`. Connect a harness with `Channels.forHarness(harness, { channels })`. The entry point also exports the turn protocol types and a draft harness interface (`AgentHarness`), which may change.
