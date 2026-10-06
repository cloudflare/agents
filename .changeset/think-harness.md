---
"agents": minor
---

Add `ThinkHarness` from the new experimental `agents/harness/think` entry point. It runs Think's agent loop as a Lifecycle capability with the same shape as `PiHarness` (`prompt`, `submit`, `wait`, `abort`, `sessions`, `session(id)`), and implements the shared harness interface Channels serves.

Transcripts live in the `Sessions` capability and in-flight model output in the `Streams` capability. Each session has one Lifecycle wake job, so a turn interrupted by an eviction picks up from its last durable write: a cut-short model call is rebuilt from its stream and continued in the same message, and a cut-short tool call is rerun or reported to the model, per tool. `ThinkChat` serves a session over Think's `useAgentChat` WebSocket protocol. See [Think harness](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/think.md).
