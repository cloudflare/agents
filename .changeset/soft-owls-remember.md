---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability and the `agents/context` module.

Sessions owns durable conversation storage: a tree of messages with branches and compaction overlays, streamed and byte-budgeted reads, and opt-in full-text search. Every table is `WITHOUT ROWID` with no secondary index, so a text append bills one row.

Sessions stores MESSAGES; it is not a file store. A message rides in one SQLite row until its serialized JSON exceeds the 1.5 MiB row budget, and a message larger than that is split across continuation rows in `cf_agents_session_message_chunks` and reassembled on read. Nothing is truncated and nothing is too large to store, so there is no size error to catch and nothing to configure. Slices are cut on UTF-8 byte boundaries and never inside a surrogate pair, so emoji and CJK content round-trips exactly like ASCII.

Splitting is not a way to shrink the database: continuation rows live in the same Durable Object as the message, inside the same 10 GB. Billing counts rows written rather than bytes, so a 500 KB message costs the same one billed row as a tiny one and a 5 MB message costs four. Sessions imposes no upper bound on a single message, so one very large write can consume a meaningful share of an object's 10 GB — `appendMessage(msg, { source: "client" })` sanitizes and strips reserved metadata but does not limit size, and bounding untrusted input is the application's job. An application that handles files should keep them in a file store and put a reference in the message, as Think does with its Workspace.

A byte budget bounds hydrated memory rather than the first slice: `getRecentHistory()` charges each row its full stored size, continuation rows included.

Prompt context moves out of conversation storage into `agents/context`: `ContextBlocks`, the frozen system prompt, `AgentContextProvider`, `AgentSearchProvider`, and the skill providers. The `Session` handle stores messages and nothing else.

Remove the superseded experimental SessionProvider, Postgres, and SessionManager stack. Existing `assistant_*` tables are lifted, verified row by row, and dropped. Add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data.
