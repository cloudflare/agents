# Sessions

The design record for `agents/sessions`, the durable conversation-history capability shared by `@cloudflare/think`, `@cloudflare/ai-chat`, and plain Lifecycle Objects.

This file records mechanism and trade-offs. The API tutorial is [docs/agents/sessions.md](../docs/agents/sessions.md); the accepted decision is [rfc-sessions.md](./rfc-sessions.md).

## Shape

A `Sessions` instance owns the `cf_agents_session_*` tables in its Durable Object SQLite database. `sessions.session(id)` returns a lightweight cached handle. The default empty ID is the normal one-conversation-per-object path.

Message rows form a tree through `parent_id`. An append without an explicit parent uses the active leaf. Passing an older parent creates a branch. The active leaf is the session's max-`seq` row. Sessions caches that leaf and the active-path aggregates in memory, so a linear append writes no counter or registry row.

Sessions requires no alarm. It works in root Durable Objects and in facets with isolated SQLite. A parent or router object owns the user-facing conversation directory.

Prompt assembly is not part of this capability. Context blocks, frozen prompts, and their providers live in `agents/context` and compose with a session handle. Sessions stores messages; nothing in it knows what a system prompt is.

**Sessions stores messages. It is not a file store.** A message can reference a file without being one. Payloads ride inline in the message row and are chunked out only when the row cannot hold them; chunking never reclaims database space, because the chunks live in the same Durable Object as the row. A Durable Object's 10 GB ceiling is therefore the real bound on how much media one conversation can hold — roughly 39,000 200 KB images, measured. An application that handles files should keep them in a file store and put a reference in the message. Think does this with its Workspace, which spills to R2 at 1,500,000 bytes.

## Write economics

A row write on Durable Object SQLite costs roughly 1000 times a row read. That ratio is the constraint the schema is built around.

Every table is `WITHOUT ROWID` with a composite primary key and no secondary index:

- `cf_agents_session_messages`, keyed `(session_id, id)`: `seq`, parent, `type`, role, message JSON, stamped token estimate, timestamp
- `cf_agents_session_compactions`, keyed `(session_id, id)`: non-destructive summary ranges
- `cf_agents_session_attachments`, keyed `(session_id, message_id, hash)`: message-to-payload references and nothing else
- `cf_agents_session_config`, keyed `(session_id, key)`: lifted session configuration
- `cf_agents_session_fts`: optional FTS5 index, created only when `searchIndexing` is enabled

A text append with search disabled bills exactly one row write. `seq` carries ordering and `type` distinguishes row kinds, so neither needs an index to be useful. The reference table's three key columns _are_ the row, so a reference costs one write rather than a write plus an index entry. The old provider maintained secondary indexes that charged every append for queries used far less often.

State is derived, not maintained. Active leaf, token totals, and session summaries all fall out of existing rows. An unchanged update writes nothing at all.

Message, FTS, and attachment-reference mutations run in one synchronous SQLite transaction. Attachment payload storage completes before that transaction. Payload deletion happens after commit.

Bulk deletion uses one recursive rewire and one set-based delete. Deleting a linear prefix rewrites only the first surviving boundary child rather than one child per deleted message.

## History reads

A history read first runs one recursive CTE over IDs, parent IDs, roles, token estimates, and stored JSON sizes. It does not carry message content through the recursive queue or sorter. The path is capped at 10,000 rows.

Sessions then fetches message content in windows bounded by both 50 rows and 4 MiB of stored JSON. In workerd the SQLite allocator shares the isolate's memory budget with the JS heap, so an oversized transient result set surfaces as `SQLITE_NOMEM` rather than as slow I/O. Both bounds exist for that reason.

`history()` releases each content window after yielding it. `historyBatches()` adds a caller-selected batch bound. `getHistory()` deliberately materializes the full path for compatibility callers.

`getRecentHistory(maxBytes, minRecent)` materializes a suffix under an explicit byte budget. The budget is charged per row as stored bytes plus, when reconstructing inline, the attachment bytes that row re-inflates. A row holding a pointer to an 8 MiB image is charged 8 MiB, not the ~100 bytes it occupies on disk. Charging stored bytes alone would let a short transcript of pointers blow the isolate's memory while reporting a tiny budget usage, so this is the difference between a budget that bounds disk and a budget that bounds memory. In pointer mode no bytes are read and only stored bytes count.

Loaded-skill restoration in `agents/context` uses the same bounded content windows in pointer mode. It does not issue one message query per assistant row.

## Attachment ownership

Sessions owns canonical attachment storage. Workspace is not an attachment store, and message durability does not depend on Computer or Shell.

A stored payload is replaced by an AI SDK-compatible pointer:

```text
attachment:sha256:<64 lowercase hex characters>
```

The hash covers the raw complete file. The pointer is a content address and encodes nothing about placement.

The attachment tables are:

- `cf_agents_session_attachment_blobs`: hash, private storage ID, byte size, and default media metadata
- `cf_agents_session_attachment_chunks`: fixed SQLite payload windows
- `cf_agents_session_attachments`: derived message references

The blob and chunk tables are lazy. A text-only object never creates them. The reference table remains part of the core Sessions schema.

### One rule, no content types

One mechanism moves every kind of oversized payload out of a row and back: `data:` URL file parts, text and reasoning parts, and strings nested in tool outputs. The stored form keeps the part's shape and swaps the payload for a pointer. Reading back reconstructs the payload byte for byte.

Storage draws no distinction between those kinds. An earlier design extracted "media" at a low fixed threshold and left everything else in the row until the row overflowed. That split was wrong on its own terms: documents do not arrive as media — a PDF read through a tool lands as plain tool-output text with no media type — so the type rule optimised the small case and ignored the large one. Deduplication, the other justification, is opportunistic and does not depend on type either.

What replaced it is one budget, with no configuration at all:

1. If the serialized row would exceed `MAX_INLINE_ROW_BYTES`, the largest payloads are chunked out until it fits.
2. Otherwise the payload stays inline.

There is no eager extraction because there is nothing eager extraction could buy. Chunking into the attachment tables does not make the database smaller: chunk rows live in the same Durable Object as the row they came out of, inside the same 10 GB. And billing counts ROWS written, not bytes — writing a 500 KB row costs the same one billed row as a tiny one, while chunking it out costs four (message, reference, blob, chunk). Inline is both cheaper and no larger, so a payload only ever moves to make an over-budget row fit.

An earlier revision added an optional R2 tier here, with a 1,500,000-byte threshold. It was deleted before release. Sessions is a message store, and hosts that handle files already have a file store: Think's Workspace spills to R2 at exactly that threshold, so the two were doing the same job twice.

Sessions never truncates. When a row still exceeds `MAX_INLINE_ROW_BYTES` (1.5 MiB) after every offloadable string has been moved out largest-first, the write throws `SessionMessageTooLargeError` rather than storing a lossy row.

That is the point of the design. A storage layer that silently shortens content makes every downstream correctness question unanswerable: a host cannot tell a model's own brevity from storage having eaten the middle of a tool result, and a replayed turn stops being a replay. Rejecting the write pushes the decision to the caller, who is the only party that knows whether the content can be split, summarized, or dropped.

### SQLite windows

SQLite payloads use immutable 1.5 MiB windows, exactly `1536 * 1024` bytes except for the final row. This is larger than Computer's 512 KiB filesystem chunks because Sessions never performs partial attachment edits. Larger windows reduce billed writes, and the remaining space below 2 MiB leaves room for SQLite record keys and encoding overhead.

Each stream pull reads one `(storage_id, chunk_index)` primary-key row. Sessions does not open a cursor over every payload BLOB.

### Writing a payload

For replayable inputs such as data URLs, strings, and byte arrays, Sessions hashes first. An existing whole-file hash causes no payload write at all.

A one-shot stream takes one path whatever its length: windows are written and hashed as the bytes arrive, so a payload is never materialized whole. A declared `bytes` is still worth passing — Sessions validates it against what actually arrived and rejects a mismatch — but it no longer changes where the bytes go.

### Resource lifetime

`attachments.put()` creates a durable resource and returns its pointer. It starts no timer, and Sessions does not infer abandonment from a temporary lack of references. The bytes survive until either `attachments.delete()` removes them, or a message has referenced them and the last reference's removal reaps them.

Those two rules cover both callers. A standalone upload that never enters a message is the uploader's to delete. An attachment that entered the transcript is collected with the last message pointing at it, so deleting messages does not leak bytes and forking does not orphan them.

Client uploads ride the same rules. The server calls `put()`, returns the pointer part, the client echoes that part in its next message, and `appendMessage(msg, { source: "client" })` accepts it because the bytes already exist in this object. A pointer the client invents or copies from elsewhere fails the same check and becomes a marker part. That is the whole trust boundary: existence in local storage, not a signature or a nonce.

Coupled message writes clean up after themselves. If offload creates a new blob and the message write fails or loses a race, Sessions deletes only the blobs that write created. It never deletes a pre-existing or shared blob by inference.

There is no age-based sweep, per-chunk timestamp, or refcount counter. A process failure at the exact commit boundary can leave unreachable storage overhead. The design accepts that rare leak rather than charging every healthy conversation for recurring scans, or risking speculative deletion of a valid standalone resource.

The low-level API requires callers to serialize `attachments.delete(pointer)` against inserting that same pointer. Think and AIChatAgent already serialize their chat mutations.

## Attachment memory behavior

Base64 data URLs decode in bounded windows. They are not converted into a second complete byte array before storage.

SQLite writes retain at most one 1.5 MiB output window plus the source chunks needed to fill it. SQLite reads load one 1.5 MiB row per stream pull.

The default inline reconstructor still returns a complete data URL for Think and AIChatAgent compatibility. It base64-encodes the attachment stream with at most a two-byte carry between chunks, but the final JavaScript string is still a whole-file allocation. `attachment.data()` also materializes the complete payload by definition. `attachment.stream()` and `attachmentResponse()` do not.

Hosts should use pointer mode for export, indexing, and unbounded scans. Model calls and legacy client snapshots must materialize bounded arrays until their protocols change.

## Search

FTS is opt-in. Search-off objects create neither the virtual table nor its shadow tables. A host that enables indexing later gets a one-time SQL-only backfill from existing valid message JSON. A new indexed message inserts directly without a preceding lookup and delete. Updates replace the existing FTS row.

Think enables search to preserve its existing behavior. AIChatAgent leaves it disabled.

## Compaction

Compaction stores an overlay that replaces a span at read time. Original rows are never deleted, so a branch stays reconstructible.

`createCompactFunction({ summarize, keepRecentTokens })` is the reference implementation and its whole surface. It protects a fixed head, protects a tail by token budget, aligns both boundaries so a tool call is never separated from its result, summarizes the middle, and folds the previous summary in on later passes. Everything else that used to be an option is now either a constant or the caller's job: a host that wants different boundaries writes its own `CompactionFunction`, which is a one-argument function returning a range and a summary.

`compactAfter(tokenThreshold)` gates on the O(1) stamped aggregate, so the cheap trigger never reads the transcript to decide whether to compact. Model-reported usage remains the authoritative count; the stamped estimate only decides when to look.

The compaction function receives pointer-mode history. Attachment payloads are never inlined into a summarization pass.

Trimming a transcript for a model request is a different concern and lives in `agents/chat` as `truncateOlderMessages`.

## Host mappings

### Think

Think installs two chat capabilities and composes context beside them:

```ts
readonly sessions = new Sessions({
  attachments: () => this.#attachmentPolicy(),
  reservedMetadataKeys: RESERVED_MESSAGE_METADATA_KEYS,
  searchIndexing: true
});

readonly streams = createChatStreams();
```

Sessions stores settled conversation messages. Streams stores in-flight output and recovery evidence. Neither capability imports the other.

`configureSession(session)` configures compaction and search on the default handle. `configureContext()` declares prompt blocks, which Think turns into a `ContextBlocks` wired to durable per-agent SQLite: a block with no provider gets storage by label, and the frozen prompt is always persisted. Think subscribes to the Sessions change feed to keep its in-isolate `messages` array coherent.

Only the top-level `attachments` option is a thunk, so Think can re-read the `sessionAttachments` host field, which is set after the field initializer runs. Individual policy fields are plain values.

Sessions' attachment store and Think's media eviction are separate concerns and must stay separate. The attachment store is storage: a large payload becomes an `attachment:sha256:` pointer and reads reconstruct it byte for byte, invisibly and losslessly. Media eviction is a context-window decision owned by Think: aged media is removed from the conversation, visibly and lossily, and preserved as a Workspace file the agent can read back by path.

`mediaEviction` supplies no storage policy at all. `minPartBytes` is Think's context threshold for what leaves the conversation; where Sessions keeps a payload is settled by the row budget alone. Eviction reads the bytes back through `sessions.attachments.open()` when the row holds a pointer, and decodes the `data:` URL in place when it does not.

Think's startup hydration uses `getRecentHistory(hydrationByteBudget, MODEL_RECENT_WINDOW)`, with the budget defaulting to 32 MiB. The floor keeps windowing from starving the model's context; the byte budget bounds hydrated memory because it charges re-inflated attachment bytes.

Think appends a regenerated assistant message under the same user parent, so the prior response remains stored. `getBranches(parentId)` lists alternatives and `getHistory({ leafId })` selects one path.

Reconciliation, current client snapshots, and model assembly still use arrays. Streaming those requires protocol work tracked here rather than hidden inside the replatform.

The primary multi-chat architecture is a directory Durable Object plus one Think Durable Object per conversation, each with its own Sessions capability. Named handles remain available for local namespaces. Facets remain appropriate for subagents and generated-code work with isolated SQLite.

### AIChatAgent

AIChatAgent uses the default handle as a linear chain. It retains its mutable `messages` field, destructive regeneration, `maxPersistedMessages`, v4 conversion, and full-transcript client protocol. The attachment ceiling, locator, and reconstructor remain tunable through `sessionAttachments`; extraction itself is not a policy.

## Migration

Lifecycle startup copies legacy `assistant_*` message, compaction, and config rows in SQL, then renames the source tables to `*__lifted_v1`. The retired `assistant_sessions` registry table is kept directly as a tombstone. Sessions does not read every registry row into JavaScript or duplicate it into KV.

AIChatAgent performs its package-owned lift from `cf_ai_chat_agent_messages`, converts old message shapes, imports a linear chain, and tombstones the source table.

Cross-object moves use `importMessage(message, { parentId, createdAt })`: one historical row written verbatim, with no offload and no change-feed event. It replaced an internal sync aperture, which existed only because import needed to bypass the write pipeline and is not a general-purpose escape hatch anyone should reach for.

## Trade-offs

SQLite-native storage removes the old Postgres provider option and its duplicate implementation.

Whole-file deduplication does not reuse matching subranges across different files. Chunk-level content addressing would add hashes, indexes, and writes while providing little benefit for compressed images and PDFs. Computer needs that complexity for partial filesystem edits; immutable attachments do not.

Default inline reconstruction preserves current chat behavior but still creates a complete base64 string. The storage layer cannot remove that final allocation without changing Think, AIChatAgent, or the model and client protocols.

Rejecting an oversized row is a visible failure where truncation was an invisible one. That is the intended trade: a host that must accept arbitrary tool output has to split or summarize it, and gets an error telling it so instead of a silently damaged transcript.

## Key decisions

- [rfc-sessions.md](./rfc-sessions.md): capability, schema, ownership, and migration decision
- [rfc-think-multi-session.md](./rfc-think-multi-session.md): parent directory plus one conversation Durable Object
- [rfc-streams.md](./rfc-streams.md): Lifecycle capability and streamed-read precedent
