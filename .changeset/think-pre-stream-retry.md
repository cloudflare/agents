---
"@cloudflare/think": patch
---

Recover an interrupted Think turn that had opened its stream but persisted no content by re-running its user message instead of trying to continue it. Think opens the resumable stream row before inference, so a Durable Object reset in the window before the first chunk left a turn with a stream id, no partial, and a user message as the latest leaf; recovery classified it as `continue`, found no assistant message to continue from, and marked the incident `skipped`. A parent tailing such a child through agent tools then sealed the run as an error. This mirrors `AIChatAgent`'s empty-partial new-turn rule (#1691).
