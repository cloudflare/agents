---
"agents": patch
---

`createAI` (`agents/models/ai-sdk`, `agents/models/pi-ai`) resumes a streamed answer from AI Gateway's `/run` when the connection drops mid-stream, replaying from the last complete event through the binding. See [docs/agents/models.md](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md#stream-resume).
