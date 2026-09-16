# Sessions as a Lifecycle capability

Status: accepted

## The problem

Conversation storage lived under `agents/experimental/memory` as a provider-based `Session` class. Think used it, AIChatAgent used a separate flat table, and plain Lifecycle Objects had no first-class history capability.

The old design had several concrete problems:

1. History APIs materialized arrays. Token estimation could reread a complete transcript on every append.
2. File parts were opaque message JSON. Large data URLs remained in message rows, images counted as zero estimated tokens, and one file could approach the SQLite row ceiling.
3. SQLite and Postgres providers duplicated message, context, and search behavior even though repository consumers used Durable Object SQLite.
4. Think and AIChatAgent maintained separate persistence and media paths over the same UI message format.
5. SessionManager combined conversation storage with a global conversation directory even though the intended deployment is one Durable Object per user conversation.

## The proposal

Add `agents/sessions` as a `LifecycleCapability`.

The capability owns:

- tree-structured SQLite message rows
- active-path navigation and branches
- non-destructive compaction overlays
- attachment payloads and message references
- optional FTS
- a local change feed for host caches

Prompt assembly is not part of it. Context blocks, frozen prompts, and their providers ship as `agents/context` and compose with a session handle.

The default Session handle represents the common one-conversation-per-object case. Named handles remain available for local namespaces and forks. A parent or router Durable Object owns conversation discovery.

History has three forms:

- an async message iterator
- bounded batches
- an explicit materialized array for compatibility

Think and AIChatAgent move onto the capability. Think retains tree behavior. AIChatAgent uses a linear chain and keeps destructive regeneration and its existing wire protocol.

## Message-storage decision

Use Durable Object SQLite directly. Remove `SessionProvider`, Postgres implementations, and SessionManager.

Every table is `WITHOUT ROWID` with a composite primary key and no secondary index, so one row write bills one row. The message table carries `seq` for ordering and `type` for the row kind, and stamps a token estimate plus a threshold-independent offload candidate size. The attachment reference table is `(session_id, message_id, hash)` and nothing else. Active-leaf and aggregate caches derive from durable rows and update in memory for linear appends.

Message, FTS, and attachment-reference mutations commit in one synchronous SQLite transaction. Attachment payload I/O happens outside that transaction.

Path traversal uses a content-free recursive CTE capped at 10,000 rows. Content then loads in windows bounded by 50 rows and 4 MiB.

FTS is opt-in. Search-off objects do not create the virtual table or its shadow tables. Enabling search after messages exist performs one SQL-only backfill.

## Attachment decision

Offload is always on and lossless, and it covers every oversized payload, not just files: `data:` URL file parts, text and reasoning parts, and strings nested in tool outputs. Reading back reconstructs the payload byte for byte. Sessions never truncates: a row that still exceeds the 1.5 MiB budget after every offloadable string has moved out is rejected with `SessionMessageTooLargeError`, because a silently shortened transcript makes every downstream correctness question unanswerable.

Store this pointer in message JSON:

```text
attachment:sha256:<64 lowercase hex characters>
```

The hash covers the raw complete file and does not encode its storage backend.

Sessions owns attachment storage rather than delegating it to Workspace. Small payloads use fixed 1.5 MiB SQLite BLOB rows. Large payloads use one private R2 object when the host supplies a bucket. Message-reference rows remain derived rather than refcounted.

Use whole-file deduplication. A replayable duplicate requires no new payload write or R2 PUT. Do not add chunk hashes or a chunk index. Computer needs chunk-level CAS because it supports partial edits and filesystem synchronization. Session attachments are immutable, and compressed images and PDFs rarely share useful aligned chunks.

Write payload bytes before committing a message pointer and reference rows. If a coupled message write fails, delete only payloads created by that operation. Never infer that a pre-existing standalone blob is abandoned.

`attachments.put()` is an explicit resource-creation API. A successful call returns a durable pointer and may legitimately have zero message references. Its bytes survive until either `attachments.delete()` removes them, or a message has referenced them and the last reference's removal reaps them. An upload that never enters a message is the uploader's to delete; one that entered the transcript is collected with the last message pointing at it.

Do not run an age-based unreferenced-blob sweep. Do not maintain a pending-R2 scan table or per-chunk timestamps. Normal failures perform immediate cleanup. A process failure at the exact cross-system commit boundary may leave unreachable storage overhead. That rare leak is preferable to recurring reads, recurring writes, and speculative deletion of valid resources.

The low-level API requires callers to serialize deletion of a standalone pointer against inserting that same pointer. Think and AIChatAgent already serialize chat mutations.

## Streaming decision

Base64 data URLs decode in bounded windows and hash incrementally. SQLite stores 1.5 MiB windows. A declared-length large stream goes directly to R2 through `FixedLengthStream`. An unknown-length stream stages in SQLite while hashing, then remains there or streams into R2.

Attachment reads return one SQLite window per pull or the R2 object body. HTTP delivery and custom reconstructors can remain streamed.

Default inline reconstruction still produces a complete data URL for compatibility. It encodes the stream incrementally with at most a two-byte base64 carry, but the final string remains a whole-file allocation. Model input and legacy client snapshots also remain bounded materialized arrays where their protocols require one.

## Skills decision

Keep first-class Agent Skills in `agents/skills`, not in Sessions message storage. Prompt-level loadable context (`R2SkillProvider` and the `load_context` tool) is a separate, smaller thing and lives in `agents/context`.

Think projects resolved `SKILL.md` files into the active workspace so Computer or legacy Shell tools can read and edit them. Computer uses `/workspace/.agents/skills`; legacy Shell uses `/.agents/skills`.

The source remains responsible for discovery and initial content. Workspace files become authoritative for subsequent activation and resource reads. Source fingerprints avoid statting and rewriting unchanged files on every wake. Resources copy lazily when first requested rather than fanning out one R2 read per resource during startup.

Workspace does not own message rows or attachment bytes.

## Migration decision

Create `cf_agents_session_*` tables and copy legacy message, compaction, and config rows in deterministic SQL order. Rename old tables to `*__lifted_v1` rather than dropping them.

Do not copy `assistant_sessions` into KV. The tombstoned table already preserves every registry row for rollback. A live conversation directory belongs in a parent Durable Object.

AIChatAgent performs a separate lift of its package-owned table and converts v4 message rows during import.

## Alternatives

### Keep the provider system

Rejected. It preserved a Postgres option at the cost of duplicate implementations, a larger contract, and no benefit for the Durable Object use case.

### Use Workspace for attachment bytes

Rejected. It makes conversation durability depend on an operational filesystem, mixes attachment lifetime with user-editable files, and behaves differently between Shell and Computer. Sessions should own message and attachment correctness. Workspace is appropriate for projected skills and model tools.

### Store every attachment directly in R2

Rejected. Small images would pay unnecessary R2 operations. SQLite windows remove media from message JSON without requiring a bucket.

### Buffer each attachment before hashing

Rejected. A fixed maximum bounds the worst case but still creates avoidable byte-array and base64 amplification. Incremental hashing and fixed windows provide an actual memory bound.

### Use Computer's 512 KiB chunks unchanged

Rejected. Computer optimizes partial edits and sync. Immutable attachments benefit from fewer 1.5 MiB rows while retaining headroom below a 2 MiB SQLite record boundary.

### Sweep unreferenced blobs by age

Rejected. Zero message references does not imply abandonment for the standalone attachment API. A sweep adds recurring scans and can delete valid resources. Explicit creation and deletion give the lifetime a clear owner.

### Make every public operation streaming

Rejected as an absolute requirement. Exports and attachment delivery can stream. AI SDK model calls, compaction functions, Think reconciliation, and existing client snapshots still require arrays. Those arrays must be bounded or explicitly requested rather than described as streams.

### Put the conversation registry in Sessions

Rejected. One Durable Object per user conversation makes discovery a routing concern. Embedding a global registry in each conversation capability repeats the wrong boundary.

## The decision

Ship `agents/sessions` as an experimental Lifecycle capability. Sessions owns message and attachment durability in SQLite with optional R2, losslessly. Prompt assembly ships beside it as `agents/context`. Replatform Think and AIChatAgent without changing their observable chat behavior. Remove the old provider stack. Project Agent Skills into Computer or legacy Shell independently of conversation storage.
