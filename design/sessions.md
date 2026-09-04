# Sessions

The design record for `agents/sessions`, the durable conversation-history capability shared by `@cloudflare/think`, `@cloudflare/ai-chat`, and plain Lifecycle Objects.

This file records mechanism and trade-offs. The API tutorial is [docs/agents/sessions.md](../docs/agents/sessions.md); the accepted decision is [rfc-sessions.md](./rfc-sessions.md).

## Shape

A `Sessions` instance owns the `cf_agents_session_*` tables in its Durable Object SQLite database. `sessions.session(id)` returns a lightweight cached handle. The default empty ID is the normal one-conversation-per-object path.

Message rows form a tree through `parent_id`. An append without an explicit parent uses the active leaf. Passing an older parent creates a branch. The active leaf is the session's max-`seq` row. Sessions reads that tail (leaf id and next `seq`) once per object lifetime and keeps it in memory, so a linear append writes no counter or registry row. Nothing else is cached: finding the tail means scanning the session's rows, which is worth one read per wake, and every other aggregate is cheap to derive from content-free rows when it is asked for.

Sessions requires no alarm. It works in root Durable Objects and in facets with isolated SQLite. A parent or router object owns the user-facing conversation directory.

Prompt assembly is not part of this capability. Context blocks, frozen prompts, and their providers live in `agents/context` and compose with a session handle. Sessions stores messages; nothing in it knows what a system prompt is.

**Sessions stores messages. It is not a file store.** A message can reference a file without being one. A message rides in one SQLite row, and a message too large for one row is split across continuation rows in the same Durable Object. Splitting never reclaims database space, so a Durable Object's 10 GB ceiling is the real bound on how much one conversation can hold. An application that handles files should keep them in a file store and put a reference in the message. Think does this with its Workspace, which spills to R2 at 1,500,000 bytes.

## Write economics

A row write on Durable Object SQLite costs roughly 1000 times a row read. That ratio is the constraint the schema is built around.

Every table is `WITHOUT ROWID` with a composite primary key and no secondary index:

- `cf_agents_session_messages`, keyed `(session_id, id)`: `seq`, parent, `type`, role, the first slice of the message JSON, the count of continuation rows, stamped token estimate, timestamp
- `cf_agents_session_message_chunks`, keyed `(session_id, id, idx)`: the remaining slices of a message too large for one row
- `cf_agents_session_compactions`, keyed `(session_id, id)`: non-destructive summary ranges
- `cf_agents_session_attachment_meta`, keyed `hash`: size, media type and chunk count of one payload
- `cf_agents_session_attachment_chunks`, keyed `(hash, idx)`: the payload bytes, in 1.5 MiB windows
- `cf_agents_session_attachment_refs`, keyed `(session_id, message_id, hash)`: which messages hold a payload alive
- `cf_agents_session_config`, keyed `(session_id, key)`: lifted session configuration
- `cf_agents_session_fts`: FTS5 index, created by the first `search()` on the object

A text append bills exactly one row write on an object that has never searched. `seq` carries ordering and `type` distinguishes row kinds, so neither needs an index to be useful. A continuation row carries its slice and nothing else, so an over-budget message costs exactly one billed row per slice. The old provider maintained secondary indexes that charged every append for queries used far less often.

State is derived, not maintained. The active leaf and the token estimate that gates auto-compaction both fall out of existing rows; there is no maintained aggregate to drift. An unchanged update writes nothing at all — and the guard compares the FULL reassembled content, not just the slice the message row holds.

Message, continuation, and FTS mutations run in one synchronous SQLite transaction. A message and its continuations always commit, are replaced, and are deleted together.

Bulk deletion uses one recursive rewire and one set-based delete. Deleting a linear prefix rewrites only the first surviving boundary child rather than one child per deleted message.

## History reads

A history read first runs one recursive CTE over IDs, parent IDs, roles, token estimates, and stored JSON sizes. It does not carry message content through the recursive queue or sorter. The path is capped at 10,000 rows.

Sessions then fetches message content in windows bounded by both 50 rows and 4 MiB of stored JSON. In workerd the SQLite allocator shares the isolate's memory budget with the JS heap, so an oversized transient result set surfaces as `SQLITE_NOMEM` rather than as slow I/O. Both bounds exist for that reason.

`history()` releases each content window after yielding it. `historyBatches()` adds a caller-selected batch bound. `getHistory()` deliberately materializes the full path for compatibility callers.

`getRecentHistory(maxBytes)` materializes a suffix under an explicit byte budget. Each row is charged its FULL stored size — the message row, every continuation row it was split across, and the attachment bytes it re-inflates — so a 12 MB message is charged 12 MB, not the 1.5 MiB its first slice occupies. Charging only the message row would let a short transcript of split messages blow the isolate's memory while reporting a tiny budget usage. There is no message-count floor beneath the budget: a floor that admitted rows regardless of size would defeat the bound it sits under. The newest message is always returned.

Reading continuations does not cost the common case anything. The bounded window selects message rows exactly as it always did, and issues one extra query for continuations only for the ids in that window whose `content_chunks` is non-zero. A window with no split messages issues no second query at all.

Loaded-skill restoration in `agents/context` uses the same bounded content windows. It does not issue one message query per assistant row.

## Row chunking

A message is stored as one JSON string. The row budget (1.5 MiB, exactly `1536 * 1024`) is what one SQLite row holds; the headroom below 2 MiB covers row keys and SQLite record overhead. A message under that budget occupies one row with `content_chunks = 0`, which is the overwhelmingly common case and costs one billed row write. A message over it is cut into slices: slice 0 stays in the message row, the rest become continuation rows numbered from 1. A read concatenates them back.

Chunking buys nothing in space, and never claimed to: continuation rows live in the same Durable Object as the message they belong to, inside the same 10 GB. Billing counts rows written, not bytes, so a 500 KB message costs the same one billed row as a tiny one and a 5 MB message costs four. A host that wants bytes to leave the object writes them to a file store; Think's Workspace spills to R2 at 1,500,000 bytes.

There is no size ceiling and therefore no size error: `SessionMessageTooLargeError` does not exist.

## Attachments

A part that declares a non-text media type and carries its bytes inline is stored outside the message. The bytes go to a content-addressed store; the part keeps its shape and its `mediaType`, with the payload field replaced by an `attachment:sha256:<hex>` pointer. A read puts the payload back, so a round trip is exact.

The rule is typed, not sized. An image is extracted whether it is 8 KB or 8 MB, and prose is never extracted at any size. That uniformity is the point: a message's stored shape does not depend on how large an image happened to be, so nothing has to explain why one image is a pointer and another is inline.

This is the opposite of an earlier revision, which extracted payloads only when a row was over budget. That made extraction a rescue mechanism competing with row chunking, and it could not even do the job it existed for — extraction needed an extractable leaf, so a row over budget from bloated metadata or thousands of small parts had nothing to extract and failed. The two mechanisms are now independent and never interact: media leaves by type before the row is measured, and chunking is a size backstop for what remains.

### What it costs, honestly

Keeping media out of the message is not free. A 200 KB image bills four rows — the message, one payload chunk, its metadata, and one reference — where inlining billed one. A 2 MiB image bills five.

What it buys is that the message row stays a few hundred bytes however large the payload is, which is what makes a byte-budgeted read a real bound and a pointer-mode read cheap. Measured against real transcripts, this is also the difference between Claude Code, whose largest message across 82,902 is 481 KB, and pi, which inlines and reaches 2.64 MB.

Because the row no longer reflects what a read materializes, `SessionRowStat.bytes` charges each message for the payloads it points at, at their inlined size. Without that a byte budget would admit a window that hydrates far larger than it measured.

Content addressing here buys idempotency, not space: a replayed append re-derives the same address and writes nothing. Two messages that happen to carry the same image do share a record, but nothing in the design depends on that being common.

Payload lifetime is derived from reference rows. A message that stops pointing at a payload drops its reference, and the payload is deleted once the last one goes. The reference table has no index on `hash`: it takes a write on every media append, and the reachability check that reads it is a scan of a small table, which is far cheaper than maintaining an index on the write path.

### Splitting on bytes, not characters

SQLite's row limit is a **byte** limit and one character can be up to four bytes, so slices are cut by accumulated UTF-8 byte length. Widths come from the code unit directly (1, 2, or 3 bytes; 4 for a surrogate pair) rather than from encoding a copy.

A surrogate pair moves as a unit, so a boundary can never land between its halves. A lone surrogate is not valid UTF-8 and SQLite may mangle it, which would silently corrupt the round-trip — the one failure this design must not have. `splitContent(s).join("")` equals `s` exactly, and that is asserted over multi-byte and emoji content that straddles a boundary.

### No upper bound, stated

Sessions imposes no maximum message size, and there is no configurable ceiling to add one. That is deliberate: "nothing is ever too large to store" is the property worth having, and a ceiling would put back the failure mode the pointer contract could not avoid.

The consequence is that one very large write can consume a meaningful share of a Durable Object's 10 GB. Bounding untrusted input is the application's job. `appendMessage(msg, { source: "client" })` sanitizes provider metadata and strips reserved metadata keys; it does not limit size, and the docs say so.

Sessions never truncates. That is the point: a storage layer that silently shortens content makes every downstream correctness question unanswerable — a host cannot tell a model's own brevity from storage having eaten the middle of a tool result, and a replayed turn stops being a replay.

## Search

The FTS index exists only on objects that have searched. The first `search()` creates the virtual table and backfills it in SQL from existing valid message JSON; from then on every write maintains it. An object that never searches creates neither the virtual table nor its shadow tables, and pays nothing per append for an index nothing reads.

This replaced a `searchIndexing` option. Think had enabled it to preserve its legacy behaviour, but nothing in Think ever called `search()`, so every Think append was billing a second row for an index only a subclass could read. Building the index on demand keeps `session.search()` working on both hosts at the cost of one backfill on first use, and deletes the option and its error class.

## Compaction

Compaction stores an overlay that replaces a span at read time. Original rows are never deleted, so a branch stays reconstructible.

`createCompactFunction({ summarize, keepRecentTokens })` is the reference implementation and its whole surface. It protects a fixed head, protects a tail by token budget, aligns both boundaries so a tool call is never separated from its result, summarizes the middle, and folds the previous summary in on later passes. Everything else that used to be an option is now either a constant or the caller's job: a host that wants different boundaries writes its own `CompactionFunction`, which is a one-argument function returning a range and a summary.

`compactAfter(tokenThreshold)` gates on a token estimate derived from the stamped per-row estimates of the active path, minus compacted spans plus their summaries. That is one content-free read per append when a threshold is configured, and it never loads the transcript to decide whether to compact. Model-reported usage remains the authoritative count; the stamped estimate only decides when to look.

Trimming a transcript for a model request is a different concern and lives in `agents/chat` as `truncateOlderMessages`.

## Host mappings

### Think

Think installs two chat capabilities and composes context beside them:

```ts
readonly sessions = new Sessions({
  reservedMetadataKeys: RESERVED_MESSAGE_METADATA_KEYS
});

readonly streams = createChatStreams();
```

Sessions stores settled conversation messages. Streams stores in-flight output and recovery evidence. Neither capability imports the other.

`configureSession(session)` configures compaction on the default handle. `configureContext()` declares prompt blocks, which Think turns into a `ContextBlocks` wired to durable per-agent SQLite: a block with no provider gets storage by label, the frozen prompt is always persisted, and the blocks load during `onStart`. Think subscribes to the Sessions change feed to keep its in-isolate `messages` array coherent.

The handle Think passes to `configureSession` is `ThinkSession`, a forwarding wrapper around the `agents/sessions` handle. It exists so a subclass written against Think 0.17 keeps compiling: the `withContext()` / `withCachedPrompt()` chain is queued and folded into the blocks `configureContext()` returns, the context accessors on the session forward to `this.context`, and `appendMessage` / `getHistory` accept their old positional arguments. It is explicit forwarding rather than a subclass or Proxy because the storage handle keeps its state in `#private` fields. The forwards are deprecated and the wrapper is the one place in Think that knows the old shape.

Row chunking and Think's media eviction are separate concerns and must stay separate. Chunking is storage: a message too large for one row is split and reassembled byte for byte, invisibly and losslessly. Media eviction is a context-window decision owned by Think: aged media is removed from the conversation, visibly and lossily, and preserved as a Workspace file the agent can read back by path.

`mediaEviction` supplies no storage policy at all. `minPartBytes` is Think's context threshold for what leaves the conversation; how Sessions lays a message out in rows is settled by the row budget alone. Eviction reads history with payloads inlined, so it decodes a `data:` URL directly and never has to resolve a pointer itself. Rewriting the message to a marker drops its reference, so the payload is collected — eviction now genuinely reclaims session storage rather than only shortening the context. Its Workspace write, its `[evicted <mediaType>, <bytes> bytes; preserved at <path>]` marker, and its `/attachments/evicted/<id>-<n>.<ext>` paths are unchanged.

Think's startup hydration uses `getRecentHistory(hydrationByteBudget)`, with the budget defaulting to 32 MiB. The budget is a hard ceiling that bounds hydrated memory because row stats charge continuation and attachment bytes; a run of unusually large messages can therefore hydrate fewer than the four messages the model replays at full fidelity, and `getHistory()` still reads the full path.

Think appends a regenerated assistant message under the same user parent, so the prior response remains stored. `getBranches(parentId)` lists alternatives and `getHistory({ leafId })` selects one path.

Reconciliation, current client snapshots, and model assembly still use arrays. Streaming those requires protocol work tracked here rather than hidden inside the replatform.

The primary multi-chat architecture is a directory Durable Object plus one Think Durable Object per conversation, each with its own Sessions capability. Named handles remain available for local namespaces. Facets remain appropriate for subagents and generated-code work with isolated SQLite.

### AIChatAgent

AIChatAgent uses the default handle as a linear chain. It retains its mutable `messages` field, destructive regeneration, `maxPersistedMessages`, v4 conversion, and full-transcript client protocol. There is nothing to configure about storage layout, so `sessionAttachments` is gone; a stored row is exactly what the write returned, so mirroring the change feed into the in-memory cache never costs a re-read.

`messages` is hydrated in `onStart` under `hydrationByteBudget`, not in the constructor, and can be a window of the stored transcript. Retention therefore counts stored rows through `getHistoryRowStats()` rather than the array. `persistMessages` compares each incoming message's JSON against the mirrored array before writing: the array is exactly what storage holds, so an equal string is already stored, and skipping it there is a string compare where letting Sessions discover it would cost a row read and, for media, a base64 decode and SHA-256 of every payload on every turn.

## Migration

Lifecycle startup copies legacy `assistant_messages` and `assistant_compactions` rows in SQL, verifies every source row has a copy holding the same payload, and drops the source. There are no tombstones: a 5 GB history kept twice inside a 10 GB object is its own outage. A source whose rows do not all verify is left in place with a `session:migration:incomplete` event and the schema version is not stamped, so the lift retries on a later start rather than stranding rows. `assistant_sessions` and `assistant_fts` are dropped outright; the registry was derived state and the index is rebuilt on first search. `assistant_config` belongs to Think, which lifts its keys into `think_config` and drops it.

AIChatAgent performs its package-owned lift from `cf_ai_chat_agent_messages` in `onStart`: it converts old message shapes, imports a linear chain in bounded windows, and drops the source only when every row imported. A row that fails to parse keeps the table in place so it stays recoverable.

The migration is one way. An object that has woken on a Sessions-backed release has an empty conversation if the code is rolled back, because the old tables are gone and old code recreates them empty. Rolling forward again is safe. The changesets say so, and a deploy that needs a rollback path canaries first.

Cross-object moves use `importMessage(message, { parentId, createdAt })`: one historical message written verbatim, split the same way an append is, with no change-feed event. It replaced an internal sync aperture, which existed only because import needed to bypass the write pipeline and is not a general-purpose escape hatch anyone should reach for.

## Trade-offs

SQLite-native storage removes the old Postgres provider option and its duplicate implementation.

The public handle is the set of calls Think and AIChatAgent make, plus `search()` and `compact()` for subclasses. `fork()`, `listSessions()`, `appendMany()`, `stats()`, and a pointer-mode read option were built and then removed before shipping because no host used them; each was a maintained code path, and `stats()` in particular was a cache with invalidation branches in every write. A capability nobody calls is not free, and a directory of conversations belongs to the application object that owns the user, not to the store.

A change-feed listener runs after the row is committed, so a listener that throws is reported through `session:error` and dispatch continues; it cannot turn a durable write into a rejected call. The `append` event is dispatched before any auto-compaction, so a cache mirror always sees the row that triggered a compaction before it sees the `compact` event.

Extracting media costs extra row writes on every media append, in exchange for a message row whose size is independent of its payloads. Text pays nothing: a prose message is one row, exactly as before.

A read of a split message is one extra query, not one per message: the window queries continuations for exactly the ids that have them. A window of ordinary messages issues none.

There is no ceiling and therefore no size error. A host that accepts arbitrary untrusted input has to bound it itself; Sessions will faithfully store whatever it is handed. Bounding what a model SEES is a different concern and lives in `agents/context`, on the read path, where a cap can change without having destroyed the stored bytes.

## Key decisions

- [rfc-sessions.md](./rfc-sessions.md): capability, schema, ownership, and migration decision
- [rfc-think-multi-session.md](./rfc-think-multi-session.md): parent directory plus one conversation Durable Object
- [rfc-streams.md](./rfc-streams.md): Lifecycle capability and streamed-read precedent
