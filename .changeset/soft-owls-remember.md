---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability and the `agents/context` module.

Sessions owns durable conversation storage: a tree of messages with branches and compaction overlays, streamed and byte-budgeted reads, opt-in full-text search, and content-addressed payload storage in 1.5 MiB Durable Object SQLite windows with an optional streamed R2 tier. Every table is `WITHOUT ROWID` with no secondary index, so a text append bills one row.

Oversized payloads are offloaded losslessly and never truncated, with no distinction between kinds of payload: a `data:` URL file part, a long text part, and a long string nested in tool output are all just payloads. One threshold moves them, and only when it buys something. With an R2 bucket configured, a payload at or above `r2ThresholdBytes` (1,500,000 by default) is extracted into R2. Otherwise a payload is extracted only when the serialized row would exceed 1.5 MiB, largest-first until it fits, and a row that still does not fit throws `SessionMessageTooLargeError`. Offloaded content reconstructs byte for byte.

Extraction is not a way to shrink the database: chunk rows live in the same Durable Object as the row they came from, inside the same 10 GB, so only R2 reclaims space. Billing counts rows written rather than bytes, so a 500 KB row costs the same one billed row as a tiny one while extracting it costs four. That is why R2 is the only eager threshold, and why the aged-row maintenance pass does nothing at all without a bucket.

A byte budget now bounds hydrated memory rather than stored bytes: `getRecentHistory()` charges each row the attachment bytes it re-inflates when reconstructing inline, so a pointer row costs its payload, not its pointer.

Prompt context moves out of conversation storage into `agents/context`: `ContextBlocks`, the frozen system prompt, `AgentContextProvider`, `AgentSearchProvider`, and the skill providers. The `Session` handle stores messages and nothing else.

Remove the superseded experimental SessionProvider, Postgres, and SessionManager stack. Existing `assistant_*` tables remain as `*__lifted_v1` rollback tombstones. Add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data.
