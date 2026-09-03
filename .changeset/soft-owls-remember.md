---
"agents": minor
---

Add the experimental `agents/sessions` Lifecycle capability and the `agents/context` module.

Sessions owns durable conversation storage: a tree of messages with branches and compaction overlays, streamed and byte-budgeted reads, and opt-in full-text search. Every table is `WITHOUT ROWID` with no secondary index, so a text append bills one row.

Sessions stores MESSAGES; it is not a file store. A message rides in one SQLite row until its serialized JSON exceeds the 1.5 MiB row budget, and a message larger than that is split across continuation rows in `cf_agents_session_message_chunks` and reassembled on read. Nothing is truncated and nothing is too large to store, so there is no size error to catch and nothing to configure. Slices are cut on UTF-8 byte boundaries and never inside a surrogate pair.

Splitting is not a way to shrink the database: continuation rows live in the same Durable Object as the message, inside the same 10 GB. Sessions imposes no upper bound on a single message, so `appendMessage(msg, { source: "client" })` sanitizes and strips reserved metadata but does not limit size; bounding untrusted input is the application's job. An application that handles files should keep them in a file store and put a reference in the message, as Think does with its Workspace.

A byte budget bounds hydrated memory rather than the first slice: `getRecentHistory()` charges each row its full stored size, continuation rows and attachments included.

Prompt context moves out of conversation storage into `agents/context`: `ContextBlocks`, the frozen system prompt, `AgentContextProvider`, `AgentSearchProvider`, and the skill providers. The `Session` handle stores messages and nothing else.

**Breaking: the experimental memory stack is removed.** The `agents/experimental/memory/session` and `agents/experimental/memory/utils` subpaths no longer exist, taking `Session.create()`, `SessionManager`, `PostgresSessionProvider`, `PostgresContextProvider`, `PostgresSearchProvider`, `R2SkillProvider`, and the `SessionProvider` interface with them. Replacements:

- `Session.create(this).withContext(...)` → install `new Sessions()` on the Lifecycle and declare blocks with `new ContextBlocks([...])` from `agents/context`.
- `createCompactFunction`, `truncateOlderMessages`, and the token estimators → `agents/sessions` and `agents/chat`.
- `AgentSearchProvider`, `AgentContextProvider` → `agents/context`.
- `SessionManager` → one `Sessions` capability holds many sessions by id; a user-facing conversation directory belongs to a parent or router Durable Object.
- Postgres providers have no replacement; Sessions is Durable Object SQLite only.

**Legacy `assistant_*` tables are lifted and dropped.** On the first wake of a Sessions-backed object, `assistant_messages` and `assistant_compactions` are copied in SQL, verified row by row, and dropped; `assistant_sessions` and `assistant_fts` are dropped. A source whose rows do not all verify is left in place with a `session:migration:incomplete` event and the schema version is not stamped, so the lift retries on a later start. There are no tombstone copies, so rolling back after a migration loses that object's conversation.

Also add Computer and legacy Shell projection to `SkillRegistry` so Agent Skills can be read and edited as workspace files without making Workspace own conversation data.
