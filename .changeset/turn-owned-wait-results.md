---
"@cloudflare/think": patch
---

Return the assistant message produced by each `runTurn({ mode: "wait" })` call, even when another turn or response hook changes the session's latest message before the caller resumes.
