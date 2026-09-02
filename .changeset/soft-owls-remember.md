---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability and the `agents/context` module.

Sessions owns durable conversation storage: a tree of messages with branches and compaction overlays, streamed and byte-budgeted reads, opt-in full-text search, and content-addressed payload storage in 1.5 MiB Durable Object SQLite windows. Every table is `WITHOUT ROWID` with no secondary index, so a text append bills one row.

Sessions stores MESSAGES; it is not a file store. Oversized payloads are extracted losslessly and never truncated, with no distinction between kinds of payload: a `data:` URL file part, a long text part, and a long string nested in tool output are all just payloads. One rule moves them, with no configuration: a payload stays inline in its message row until the serialized row would exceed 1.5 MiB, then the largest payloads are chunked out until it fits. A row that still does not fit throws `SessionMessageTooLargeError`. Extracted content reconstructs byte for byte.

Chunking is not a way to shrink the database: chunk rows live in the same Durable Object as the row they came from, inside the same 10 GB, so extraction never reclaims a byte — it only makes an over-budget row fit. Billing counts rows written rather than bytes, so a 500 KB row costs the same one billed row as a tiny one while chunking it out costs four. A Durable Object's 10 GB ceiling is the real bound on how much media one conversation can hold, roughly 39,000 200 KB images; an application that handles files should keep them in a file store and put a reference in the message, as Think does with its Workspace.

A byte budget now bounds hydrated memory rather than stored bytes: `getRecentHistory()` charges each row the attachment bytes it re-inflates when reconstructing inline, so a pointer row costs its payload, not its pointer.

Prompt context moves out of conversation storage into `agents/context`: `ContextBlocks`, the frozen system prompt, `AgentContextProvider`, `AgentSearchProvider`, and the skill providers. The `Session` handle stores messages and nothing else.

Remove the superseded experimental SessionProvider, Postgres, and SessionManager stack. Existing `assistant_*` tables remain as `*__lifted_v1` rollback tombstones. Add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data.
