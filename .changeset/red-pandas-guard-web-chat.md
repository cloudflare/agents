---
"agents": patch
---

Harden the Web Channel: browser turns only enter transient history once Host routing accepts them, conversation-wide replies survive the initiating owner disconnecting, durable-only recording reports `uncertain` instead of `delivered`, canonical history keeps one evolving part per tool call, replay discovery pages past newer streams from other Channels, canonical snapshots keep source documents, files, and persisted data parts, approvals must match a pending request issued to the same conversation and participant, and `web()` no longer derives conversation or participant identity from request query parameters. `Streams.list()` accepts an `after` cursor so a caller can page a tag beyond the first page.
