---
"agents": patch
---

Preserve AI SDK v7 trace hierarchy by parenting `chat` and `execute_tool` spans under their `invoke_agent` operation span. This also keeps nested provider requests under `chat` and model calls made by tools under `execute_tool`.
