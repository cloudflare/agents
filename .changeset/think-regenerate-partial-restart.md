---
"@cloudflare/think": patch
"agents": patch
---

Keep a regeneration interrupted by a restart on its own branch.

When a restart interrupted a regeneration that had already streamed part of its answer, recovery attached that partial answer under the response it was replacing, and the continuation then extended it with the replaced response still in the prompt. Think now records the parent message on the regeneration's resumable stream (`ResumableStream.start({ parentMessageId })`, read back with `getStreamParentMessageId()`), and orphan recovery appends the partial under it, so the continuation extends the new answer beside the old one.
