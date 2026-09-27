---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix agent-tool replay, re-attach, and fiber recovery edge cases.

- Reconnecting after a mid-stream milestone no longer duplicates the last chunk or drops chunks streamed while the client was away. Stored chunks are numbered by their stored position on both the live and replay paths, and progress and milestone frames no longer consume a sequence.
- After a parent restart, chunks the re-attached child streams are numbered after the ones clients already saw, so connected clients no longer drop them.
- A child's tail now realigns a cold live counter even when re-attaching after the last stored chunk, so post-restart chunks are forwarded instead of dropped.
- Connect-time replay reads milestones without reconciling (and possibly sealing) a stale child run, and is bounded by a timeout. `inspectAgentToolRun` accepts `{ reconcile: false }` for read-only inspection.
- A managed fiber whose body settled but whose cleanup failed is settled as completed instead of being reported interrupted, and terminal managed fibers no longer emit `fiber:recovery:detected` / `fiber:run:interrupted`.
- Think no longer treats a settled chat-turn fiber row as recovery evidence, migrates an older agent-tool child-run table before rebinding a recovered turn, and both chat hosts stop suppressing a terminal-only run's chunks once its recovered turn settles.
