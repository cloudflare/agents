---
"@cloudflare/think": patch
---

Return the assistant message produced by each `runTurn({ mode: "wait" })` call, even when another turn or response hook changes the session's latest message before the caller resumes. The message is matched to the turn's request ID, so a later persist that inherits the call's async context cannot replace it.

A completed turn that persists no assistant message (for example, a continuation whose only output is structured) now returns no `message`, instead of the previous assistant message in the session.
