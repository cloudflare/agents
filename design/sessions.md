# Sessions

`agents/sessions` is the durable conversation-history capability shared by `@cloudflare/think`, `@cloudflare/ai-chat`, and plain Lifecycle Objects.

## How it works

A `Sessions` instance owns `cf_agents_session_*` tables in its Durable Object SQLite database. `sessions.session(id)` returns a lightweight handle. The default empty ID is the normal one-conversation-per-object path.

Message rows form a tree through `parent_id`. An append without an explicit parent uses the active leaf. Passing an older parent creates a branch. The most recently appended childless row is the active leaf. Sessions caches that leaf and active-path aggregates in memory, so a linear append does not write a counter or registry row.

Sessions requires no alarm. It works in root Durable Objects and facets with isolated SQLite. A parent or router object owns the user-facing conversation directory.

## Message storage

The main tables are:

- `cf_agents_session_messages`: message JSON, parent, role, token estimate, largest media-maintenance candidate, and timestamp
- `cf_agents_session_compactions`: non-destructive summary ranges
- `cf_agents_session_attachments`: message-to-attachment references
- `cf_agents_session_config`: lifted Session configuration
- `cf_agents_context_blocks`: writable context and frozen prompts
- `cf_agents_session_fts`: optional FTS5 index, created only when `searchIndexing` is enabled

The message table has no secondary indexes. With search disabled, a text append changes one SQLite row. The old provider maintained indexes that added writes to every append for queries used far less often.

Message, FTS, and attachment-reference mutations run in one synchronous SQLite transaction. Attachment payload storage completes before that transaction. Payload deletion occurs after commit and never holds a SQLite transaction across R2 I/O.

Bulk deletion uses one recursive rewire and one set-based delete. Deleting a linear prefix rewrites only the first surviving boundary child rather than rewriting one child per deleted message.

## History reads

A history read first runs one recursive CTE over IDs, parent IDs, roles, token estimates, candidate sizes, and stored JSON sizes. It does not carry message content through the recursive queue or sorter. The path is capped at 10,000 rows.

Sessions then fetches message content in windows bounded by both:

- 50 rows
- 4 MiB of stored message JSON

`history()` releases each content window after yielding it. `historyBatches()` adds a caller-selected batch bound. `getRecentHistory()` materializes a suffix under an explicit byte budget. `getHistory()` deliberately materializes the full path for compatibility callers.

Loaded-skill restoration uses the same bounded content windows. It does not issue one message query per assistant row.

## Attachment ownership

Sessions owns canonical attachment storage. Workspace is not an attachment store and message durability does not depend on Computer or Shell.

A stored file part retains the AI SDK-compatible shape:

```text
attachment:sha256:<64 lowercase hex characters>
```

The hash covers the raw complete file. Whole-file identity is stable across SQLite and R2 placement.

The attachment tables are:

- `cf_agents_session_attachment_blobs`: hash, backend, private storage ID, R2 key, byte size, and default media metadata
- `cf_agents_session_attachment_chunks`: fixed SQLite payload windows
- `cf_agents_session_attachments`: derived message references, including per-part filename and media type

The blob and chunk tables are lazy. A text-only object never creates them. The reference table remains part of the core Sessions schema.

### SQLite windows

SQLite payloads use immutable 1.5 MiB windows, exactly `1536 * 1024` bytes except for the final row. This is larger than Computer's 512 KiB filesystem chunks because Sessions never performs partial attachment edits. Larger windows reduce billed writes. The remaining space below 2 MiB leaves room for SQLite record keys and encoding overhead.

Each stream pull reads one `(storage_id, chunk_index)` primary-key row. Sessions does not open a cursor over every payload BLOB.

### R2 tier

R2 is optional. The default R2 threshold is 1,500,000 bytes. Sessions owns private random object keys beneath `cf-agents/sessions/attachments` unless the host configures another prefix.

For replayable inputs such as data URLs, strings, and byte arrays, Sessions hashes first. An existing whole-file hash causes no payload write or R2 PUT. A new large payload streams to one R2 object.

For a one-shot stream with a declared byte length, a large payload streams directly to R2 through `FixedLengthStream` while Sessions hashes and enforces the size ceiling.

An unknown-length one-shot stream is staged in 1.5 MiB SQLite windows while hashing. If it crosses the R2 threshold, Sessions streams those windows to R2 and removes them. Callers should pass `bytes` when they know the content length to avoid staging writes.

### Resource lifetime

`attachments.put()` creates a valid durable resource and returns its pointer. It does not start a timer and Sessions does not infer abandonment from a temporary lack of message references. The caller owns inserting the pointer into a message. If the caller changes its mind, it can call `attachments.delete(pointer)` while the blob is unreferenced.

Think and AIChatAgent use the coupled message-write path. If extraction creates a new blob and the message write loses a race, fails, or is ignored by policy, Sessions deletes only the blob created by that failed operation. It never deletes a pre-existing standalone or shared blob based on inference.

Deleting messages removes their reference rows. Sessions deletes the payload when no reference remains. Forking inside one object copies reference rows and shares the payload.

There is no age-based attachment sweep, pending-R2 scan, per-chunk timestamp, or refcount counter. Normal failed operations clean up their own staged bytes. A process failure at the exact R2 or SQLite commit boundary can leave unreachable storage overhead. The design accepts that rare leak rather than charging every healthy conversation for recurring scans or risking speculative deletion of a valid standalone resource.

The low-level API requires callers to serialize `attachments.delete(pointer)` against inserting that same standalone pointer. Think and AIChatAgent already serialize their chat mutations.

## Attachment memory behavior

Base64 data URLs decode in bounded windows. They are not converted into a second complete byte array before storage.

SQLite writes retain at most one 1.5 MiB output window plus source chunks needed to fill it. SQLite reads load one 1.5 MiB row per stream pull. R2 reads return the object body.

The default inline reconstructor still returns a complete data URL for Think and AIChatAgent compatibility. It base64-encodes the attachment stream and carries at most two bytes between chunks, but the final JavaScript string must still fit in memory. `attachment.data()` also materializes the complete payload by definition. `attachment.stream()` and `attachmentResponse()` do not.

Pointer-mode history performs no attachment reads:

```ts
for await (const message of session.history({ reconstruct: "pointer" })) {
  // Stored attachment URLs remain unchanged.
}
```

Hosts should use pointer mode for export, indexing, maintenance, and unbounded scans. Model calls and legacy client snapshots must materialize bounded arrays until their protocols change.

## Aged media maintenance

Aged maintenance handles inline media left by older releases and large strings nested in tool outputs. New writes stamp the largest externalizable payload size while the parsed message is already in memory. Maintenance compares that threshold-independent number against current policy, so lowering Think's threshold later still finds older candidates.

Rows with no candidates never enter the maintenance content query. A conservative legacy hint is corrected once after inspection. Backlog checks select only an ID and do not load another large message.

The pass is bounded by row count, writes payloads before rewriting a message, and uses content compare-and-swap. Think's `externalizeToWorkspace` option name remains for compatibility, but `true` now means preserve bytes in Sessions attachment storage. `false` retains the explicit lossy mode.

## Search

FTS is opt-in. Search-off objects do not create the FTS table or its shadow tables. A host that enables indexing later gets a one-time SQL-only backfill from existing valid message JSON. A new indexed message inserts directly without a preceding lookup and delete. Updates replace the existing FTS row.

Think enables search to preserve its existing behavior. AIChatAgent leaves it disabled.

## Context and Agent Skills

Session context blocks, frozen prompts, lower-level loadable context providers, and search providers remain part of the Session handle.

First-class Agent Skills live in `agents/skills`, not in conversation storage. Think projects each resolved `SKILL.md` into its active workspace:

- Computer: `/workspace/.agents/skills/<name>/SKILL.md`
- legacy Shell: `/.agents/skills/<name>/SKILL.md`

Think records a durable source fingerprint. An unchanged cold wake attaches the registry to the existing projection without statting or rewriting every skill file. Source changes seed missing or replacement instructions according to policy. Existing files are preserved by default.

Resources are lazy. Startup does not read and copy every script, reference, or asset. The first resource read or script run copies that file into the workspace; later reads use the workspace copy and therefore observe edits.

The workspace projection is an operational copy for tools. It does not own messages, attachment bytes, or the Session graph.

## Host mappings

### Think

Think retains its message cache, reconciliation, broadcasts, model assembly, branch behavior, context, compaction, search, and explicit lossy media mode. Its public arrays and wire protocol remain unchanged. It uses bounded recent hydration on wake but still performs full materialized reads where existing reconciliation semantics require them.

### AIChatAgent

AIChatAgent uses the default Session handle as a linear chain. It retains its mutable `messages` field, destructive regeneration, `maxPersistedMessages`, v4 conversion, and full-transcript client protocol. Attachment offload remains opt-in through `sessionAttachments`.

## Migration

Lifecycle startup copies legacy `assistant_*` message, compaction, and config rows in SQL, then renames source tables to `*__lifted_v1`. The retired `assistant_sessions` registry table is retained directly as a tombstone. Sessions does not read every registry row into JavaScript or duplicate it into KV.

AIChatAgent performs its package-owned lift from `cf_ai_chat_agent_messages`, converts old message shapes, imports a linear chain, and tombstones the source table.

## Key decisions

- [rfc-sessions.md](./rfc-sessions.md): capability, schema, ownership, and migration decision
- [rfc-think-multi-session.md](./rfc-think-multi-session.md): parent directory plus one conversation Durable Object
- [rfc-streams.md](./rfc-streams.md): Lifecycle capability and streamed-read precedent

## Tradeoffs

SQLite-native storage removes the old Postgres provider option and its duplicate implementation.

Whole-file deduplication does not reuse matching subranges across different files. Chunk-level content addressing would add hashes, indexes, and writes while providing little benefit for compressed images and PDFs. Computer needs that complexity for partial filesystem edits; immutable attachments do not.

Default inline reconstruction preserves current chat behavior but still creates a complete base64 string. The storage layer cannot remove that final allocation without changing Think, AIChatAgent, or the model/client protocol.
