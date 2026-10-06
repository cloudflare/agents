---
"agents": minor
---

Add `ThinkHarness` from the new experimental `agents/harness/think` entry point. It runs Think's agent loop as a Lifecycle capability with the same shape as `PiHarness` (`prompt`, `submit`, `wait`, `abort`, `sessions`, `session(id)`), and implements the shared harness interface Channels serves.

The harness owns its storage: transcripts in the Sessions tables, with `branches()`, `search()` and `compact()` on each session, and in-flight model output in the Streams tables, so a host installs only the harness. Each session has one Lifecycle wake job, so a turn interrupted by an eviction picks up from its last durable write: a cut-short model call is rebuilt from its stream and continued in the same message, and a cut-short tool call is reported to the model, or rerun when the tool carries `recovery: "rerun"`. `ThinkChat` serves a session over Think's `useAgentChat` WebSocket protocol. See [Think harness](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/think.md).
