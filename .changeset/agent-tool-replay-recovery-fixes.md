---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix agent-tool replay, re-attach, and fiber recovery edge cases.

- Reconnecting after a mid-stream milestone no longer duplicates the last chunk or drops chunks streamed while the client was away. Stored chunks are numbered by their stored position on both the live and replay paths, and progress and milestone frames no longer consume a sequence.
- After a parent restart, chunks the re-attached child streams are numbered after the ones clients already saw, so connected clients no longer drop them.
- A child's tail now realigns a cold live counter even when re-attaching after the last stored chunk, so post-restart chunks are forwarded instead of dropped.
- A child's tail no longer duplicates a stored chunk, or drops a progress/milestone frame, when they are broadcast while the tail drains its backlog. Progress and milestone frames no longer consume a live sequence on the child either, and tails forward them outside the stored-chunk dedupe.
- A chunk too large to store (broadcast live but never replayed) no longer shifts the numbering of later chunks, so a reconnect after one neither drops nor duplicates text. It is forwarded with a unique `unstoredId` on `AgentToolStoredChunk` and the `chunk` event, which clients dedupe on instead of its sequence.
- A re-attaching tail seeds a cold live counter from the stored backlog before it starts listening, so a chunk the recovered turn broadcasts while the tail drains or inspects the run is forwarded instead of dropped.
- Each `reportProgress` frame carries a unique `id`, so a repeated identical progress update is no longer deduped away by `useAgentToolEvents` and `progress.at` stays current.
- Connect-time replay reads milestones without reconciling (and possibly sealing) a stale child run. Each run's replay, including resolving its child, shares one timeout budget, so an unresponsive child no longer stalls `onConnect` or later runs. `inspectAgentToolRun` accepts `{ reconcile: false }` for read-only inspection.
- A managed fiber whose body settled but whose cleanup failed is settled with the body's own outcome (completed, error with its message, or aborted) instead of being reported interrupted or always completed, and terminal managed fibers no longer emit `fiber:recovery:detected` / `fiber:run:interrupted`.
- Think no longer treats a settled chat-turn fiber row as recovery evidence, migrates an older agent-tool child-run table before rebinding a recovered turn, and both chat hosts stop suppressing a terminal-only run's chunks once its recovered turn settles.
