---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability and the `agents/context` module.

Sessions owns durable conversation storage: a tree of messages with branches and compaction overlays, streamed and byte-budgeted reads, opt-in full-text search, and content-addressed payload storage in 1.5 MiB Durable Object SQLite windows with an optional streamed R2 tier. Every table is `WITHOUT ROWID` with no secondary index, so a text append bills one row.

Oversized payloads are offloaded losslessly and never truncated. Media leaves the row at a size threshold, whether it arrives as a file part or as a `data:` URL nested in tool output. Anything else, prose included, is offloaded largest-first only when the row cannot hold it, and a row that still does not fit throws `SessionMessageTooLargeError`. Offloaded content reconstructs byte for byte.

A byte budget now bounds hydrated memory rather than stored bytes: `getRecentHistory()` charges each row the attachment bytes it re-inflates when reconstructing inline, so a pointer row costs its payload, not its pointer.

Prompt context moves out of conversation storage into `agents/context`: `ContextBlocks`, the frozen system prompt, `AgentContextProvider`, `AgentSearchProvider`, and the skill providers. The `Session` handle stores messages and nothing else.

Remove the superseded experimental SessionProvider, Postgres, and SessionManager stack. Existing `assistant_*` tables remain as `*__lifted_v1` rollback tombstones. Add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data.
