# Sessions

> **Experimental.** Everything exported from `agents/sessions` may change between releases while the API stabilizes.

`agents/sessions` stores durable conversation history in a [Lifecycle Object](./lifecycle.md). It provides tree-structured messages, streamed and byte-budgeted reads, compaction overlays, optional full-text search, and lossless payload offload.

Sessions stores messages. Prompt assembly lives in [`agents/context`](./context.md) and composes with a session handle rather than living inside it.

`Think` and `AIChatAgent` use this capability for message persistence. You can also install it on a plain Durable Object.

## Install the capability

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";

export class ConversationObject extends DurableObject<Env> {
  readonly sessions = new Sessions();
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly session = this.sessions.session();
}
```

On an `Agent`, install it in the constructor:

```ts
import { Agent, type AgentContext } from "agents";
import { Sessions } from "agents/sessions";

export class ConversationAgent extends Agent<Env> {
  readonly sessions = new Sessions();
  readonly session = this.sessions.session();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.sessions);
  }
}
```

The default session ID is an empty string. This is the primary path when one Durable Object owns one conversation.

Sessions needs no alarm, so it also works on facets, which have isolated SQLite but no independent alarm slot.

## Write messages

`UIMessage` from the AI SDK is structurally compatible with `SessionMessage`.

```ts
const result = await this.session.appendMessage({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
});

result.inserted; // false when this ID already existed
result.message; // exact stored form
result.attachments; // payloads offloaded by this write
```

An append without `parentId` attaches to the active leaf. Pass `null` to create a root or pass a message ID to create a branch:

```ts
await this.session.appendMessage(alternativeReply, {
  parentId: userMessage.id
});
```

Every write runs the same pipeline: sanitize provider metadata, strip reserved metadata and guard pointers on client input, move oversized payloads into attachment storage, then commit the row. Payload writes complete before the row commits, so a stored pointer always has durable bytes behind it.

Mark untrusted input with `source: "client"`:

```ts
const sessions = new Sessions({
  reservedMetadataKeys: ["channel", "turnMetadata"]
});

await sessions.session().appendMessage(clientMessage, {
  source: "client"
});
```

This strips reserved metadata keys and rejects attachment pointers whose bytes are not already stored in this object.

Other writes:

```ts
await session.updateMessage(message); // SessionMessage | null
await session.upsertMessage(message);
await session.appendMany(messages);
await session.deleteMessages([messageId]);
await session.clearMessages();
```

`updateMessage()` returns the stored form of the message, or `null` when the ID is not in this session. It does not throw for an absent row. An unchanged message writes nothing and dispatches no change event.

Deleting a message splices its children to its parent. Removing a message in the middle of a chain does not make older history unreachable.

### Row budget

A serialized message row is capped at `MAX_INLINE_ROW_BYTES` (1.5 MiB). Sessions never truncates content to make a row fit. It offloads oversized strings largest-first until the row fits, and if the row still exceeds the budget after every offloadable payload has moved out, the write throws `SessionMessageTooLargeError`:

```ts
import { SessionMessageTooLargeError } from "agents/sessions";

try {
  await session.appendMessage(message);
} catch (error) {
  if (error instanceof SessionMessageTooLargeError) {
    error.messageId;
    error.bytes; // serialized size after offload
    error.maxBytes; // 1.5 MiB
  }
}
```

## Read history

Prefer streamed reads for unbounded history:

```ts
for await (const message of session.history()) {
  await consume(message);
}
```

The capability first reads a content-free path of IDs and row sizes. It then fetches content in queries bounded to 50 rows and 4 MiB. Earlier chunks are not retained by the iterator.

Use `historyBatches()` when each downstream operation has a fixed cost:

```ts
for await (const batch of session.historyBatches({
  batchSize: 25,
  maxBatchBytes: 2 * 1024 * 1024
})) {
  await sendBatch(batch);
}
```

Use a byte-budgeted recent window during Durable Object startup:

```ts
const recent = await session.getRecentHistory(8 * 1024 * 1024, 4);

recent.messages;
recent.truncated;
recent.totalContentBytes;
```

The second argument is a minimum number of recent messages. The minimum can exceed the byte budget, so choose it deliberately.

The budget counts what hydration actually costs. Each row is charged its stored bytes plus, when reconstructing inline, the attachment bytes its pointers inflate back. A row holding a pointer to an 8 MiB image is charged 8 MiB, not the ~100 bytes it occupies on disk. That is what makes the budget a bound on isolate memory rather than on the on-disk footprint. In pointer mode no attachment bytes are read, so only stored bytes count.

`getRecentHistory()` schedules a maintenance pass when it had to truncate, on the assumption that a transcript that overflows its budget has aged rows worth draining.

`getHistory()` materializes the selected path and exists for consumers that require an array:

```ts
const messages = await session.getHistory();
```

Do not use `getHistory()` for an unbounded transcript inside a memory-constrained Durable Object. Prefer `history()`, `historyBatches()`, or `getRecentHistory()`.

Other reads:

```ts
await session.getMessage(id);
await session.getLatestLeaf();
await session.getBranches(parentId);
await session.getHistoryRowStats();
await session.stats();
```

`getHistoryRowStats()` returns per-row stored bytes, attachment bytes, stamped token estimates, and the largest remaining offload candidate, without loading message content. `stats()` derives path length, stored content bytes, attachment bytes, and a heuristic token estimate for the active path with compaction overlays applied.

## Branches and forks

A message can have multiple children. Read one root-to-leaf path by selecting its leaf:

```ts
const branch = await session.getHistory({ leafId: alternativeReply.id });
const alternatives = await session.getBranches(userMessage.id);
```

Fork a path into another session in the same Durable Object:

```ts
const fork = await session.fork({
  atMessageId: alternativeReply.id,
  toSessionId: "draft-copy"
});
```

Forked messages receive new IDs. Content-addressed attachment blobs are shared through new reference rows rather than copied. Compaction overlays are not copied.

To move a conversation between Durable Objects, export the source with `history({ reconstruct: "pointer" })` and replay it with `importMessage()` on the destination:

```ts
let parentId: string | null = null;
for await (const message of source.history({ reconstruct: "pointer" })) {
  await destination.importMessage(message, {
    parentId,
    createdAt: message.createdAt?.getTime() ?? Date.now()
  });
  parentId = message.id;
}
```

`importMessage()` writes one historical message verbatim: explicit parent and timestamp, no offload, no change-feed event. Copy attachment blobs separately when the two objects do not share an attachment namespace. A pointer-mode export carries pointers, not bytes.

For one-Durable-Object-per-conversation applications, keep the conversation directory in a parent or router Durable Object.

## Compaction

Compaction overlays replace a range at read time without deleting the original rows:

```ts
import { createCompactFunction } from "agents/sessions";

session
  .onCompaction(
    createCompactFunction({
      summarize: async (prompt) => summarize(prompt),
      keepRecentTokens: 20_000
    })
  )
  .compactAfter(80_000);
```

`createCompactFunction` takes exactly two options. `summarize` calls the model with a prompt and returns its text. `keepRecentTokens` is the token budget for the recent tail kept verbatim, defaulting to 20,000. The first three messages are kept verbatim as the head, at least the last two are kept as the tail, and the boundaries are aligned so a tool call is never separated from its result.

Run it explicitly:

```ts
await session.compact();
await session.compact(leafId); // compact a specific branch
```

Or store an already-produced summary:

```ts
await session.addCompaction(summary, fromMessageId, toMessageId);
```

The compaction function receives pointer-mode history, so attachment payloads are never inlined into a summarization pass.

Sessions stamps each message with a token estimate when the row is written. `compactAfter()` gates on that O(1) aggregate and never reads the transcript to decide whether to compact. Auto-compaction failures are non-fatal: they log, emit `session:error`, and leave the transcript alone.

To trim a transcript before handing it to a model, `truncateOlderMessages` is exported from [`agents/chat`](./chat-agents.md), not from `agents/sessions`.

## Attachments

Offload is always on and always lossless. It applies to every oversized payload, not just files:

- `data:` URL file parts
- text and reasoning parts
- strings nested inside tool outputs

The stored form keeps the part's shape and replaces the payload with an `attachment:sha256:<hash>` pointer. Bytes live in content-addressed storage. Reading back inlines the payload again, so a round-trip is exact, byte for byte. Nothing is truncated or summarized to make something fit.

Configure the policy with plain values:

```ts
import { Sessions } from "agents/sessions";

readonly sessions = new Sessions({
  attachments: {
    inlineThresholdBytes: 32 * 1024,
    maxAttachmentBytes: 32 * 1024 * 1024,
    r2: env.ATTACHMENTS,
    r2ThresholdBytes: 1_500_000
  }
});
```

| Option                      | Default                          | Meaning                                                    |
| --------------------------- | -------------------------------- | ---------------------------------------------------------- |
| `r2`                        | none                             | Optional large-object tier                                 |
| `r2ThresholdBytes`          | `1_500_000`                      | Payloads at or above this size use R2 when configured      |
| `r2Prefix`                  | `cf-agents/sessions/attachments` | Private R2 object-key prefix                               |
| `inlineThresholdBytes`      | 32 KiB                           | Payloads at or above this size are offloaded               |
| `maxAttachmentBytes`        | 32 MiB                           | Ceiling for one attachment payload                         |
| `basePath`                  | `/attachments`                   | Logical locator prefix exposed to reconstructors           |
| `keepRecentMessages`        | `8`                              | Rows this close to the leaf keep inline payloads untouched |
| `maxMaintenanceRowsPerPass` | `64`                             | Maximum aged rows rewritten by one maintenance pass        |
| `maintenance`               | `true`                           | Run the aged-row maintenance pass                          |
| `reconstruct`               | inline                           | Read-side materialization default for file parts           |

Individual fields are plain values, not thunks. Only the top-level `attachments` option may be a function, which is re-read on every access so an `Agent` subclass can point it at bindings or policy fields that are initialized after the field initializer runs:

```ts
readonly sessions = new Sessions({
  attachments: () => ({ r2: this.env.ATTACHMENTS })
});
```

Sessions owns the payload tables, private R2 keys, message references, deduplication, and deletion. Workspace is not part of attachment durability.

Without R2, Sessions stores every offloaded payload in Durable Object SQLite. With R2, payloads below `r2ThresholdBytes` stay in SQLite and larger payloads use one private R2 object.

SQLite payloads are split into 1.5 MiB rows. Each read pulls one row by `(storage_id, chunk_index)`. The final row can be shorter.

The write order is:

1. Decode and hash the payload incrementally.
2. Reuse an existing whole-file hash or write a new payload.
3. Commit the message, optional FTS row, and attachment references in one SQLite transaction.

### Upload a stream

`attachments.put()` accepts a `ReadableStream`, `Uint8Array`, `ArrayBuffer`, or string:

```ts
const contentLength = request.headers.get("content-length");
const { part } = await sessions.attachments.put(request.body!, {
  mediaType: request.headers.get("content-type") ?? "application/octet-stream",
  filename: "document.pdf",
  ...(contentLength ? { bytes: Number(contentLength) } : {})
});
```

Pass `bytes` when the stream length is known. A large declared-length stream goes directly to R2 through a fixed-length stream while Sessions hashes it. An unknown-length stream is staged in 1.5 MiB SQLite windows until Sessions knows its hash and placement.

A payload exceeding `maxAttachmentBytes` throws `SessionAttachmentTooLargeError` before anything commits.

### Attachment lifetime

`put()` stores bytes that survive until one of two things happens:

- `attachments.delete()` removes them explicitly, or
- a message has referenced them and the last remaining reference is removed, which reaps them.

So an attachment created by `put()` and never referenced stays until you delete it, and an attachment that entered the transcript is garbage-collected with the last message that pointed at it.

```ts
await sessions.attachments.delete(part.url);
```

`delete()` returns `false` while any stored message still references the hash, and `false` when the hash is unknown.

There is no age-based unreferenced-blob sweep. A coupled message write cleans up only the payloads that write created, if the row write fails or loses a race. It never infers that a pre-existing payload is abandoned.

Serialize `attachments.delete(pointer)` against inserting that same pointer into a message. Think and AIChatAgent already serialize their chat mutations.

### Client uploads

A browser uploading a file does not send bytes through the message. The server stores them, hands back a pointer part, and the client echoes that part in its next message:

1. The client uploads to your endpoint, which calls `sessions.attachments.put(...)`.
2. The endpoint returns the `part` from that call to the client.
3. The client includes `part` verbatim in the parts of its next chat message.
4. The server appends it with `appendMessage(message, { source: "client" })`.

Step 4 accepts the pointer precisely because the bytes exist in this object. Client-source writes look up every pointer in the message and keep only the ones whose payload is already stored here. A pointer a client invents, or copies from another object, is replaced with a short marker part instead of being trusted.

### Storage operations

For a new small attachment that fits one SQLite window, an append changes:

- one whole-file blob row
- one payload chunk row
- one message row
- one message-reference row

Each additional 1.5 MiB payload window adds one row. A new R2-backed attachment uses one R2 PUT and stores blob, message, and reference metadata in SQLite. A replayable duplicate performs no payload write or R2 PUT.

A declared-length one-shot stream cannot be deduplicated until its hash is known. If its bytes already exist, Sessions deletes the newly uploaded private object and reuses the stored hash.

## Reconstruct attachments

History reads support three modes.

### Inline

The default restores the original payload exactly: a file part becomes its `data:` URL again, and offloaded text comes back as text.

```ts
for await (const message of session.history({ reconstruct: "inline" })) {
  // AI SDK-compatible file parts
}
```

Sessions base64-encodes the attachment stream incrementally, carrying at most two bytes between input chunks. The final data URL is still one JavaScript string. Use inline reconstruction only for a bounded message range.

### Pointer

Pointer mode performs no attachment reads:

```ts
for await (const message of session.history({ reconstruct: "pointer" })) {
  // file.url remains attachment:sha256:<hash>
}
```

Use pointer mode for exports, indexing, maintenance, and cross-Durable-Object transfer.

### Custom reconstruction

A reconstructor is the read-side plugin for file parts. It receives lazy byte access:

```ts
const publicUrlReconstructor = {
  part(attachment) {
    return {
      type: "file",
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      url: `https://files.example.com/${attachment.hash}`
    };
  }
};

await session.getRecentHistory(4 * 1024 * 1024, 4, {
  reconstruct: publicUrlReconstructor
});
```

The attachment object provides `data()`, `dataUrl()`, and `stream()`. `data()` deliberately materializes all bytes. `stream()` returns one SQLite window at a time or the R2 object body. `attachment.path` is a logical Sessions locator, not a Workspace path.

A custom reconstructor applies to file parts. Offloaded text and reasoning always return as text.

Missing payloads become a short marker part. They do not make the rest of the transcript unreadable.

## Serve attachments over HTTP

```ts
import { attachmentResponse } from "agents/sessions";

async onRequest(request: Request) {
  const hash = new URL(request.url).pathname.split("/").at(-1)!;
  return attachmentResponse(this.sessions, hash);
}
```

The response streams from Sessions storage and sets content type, content length, and content disposition headers from stored metadata.

## Maintenance

Payloads that are still inline in aged rows are drained by a bounded maintenance pass. It covers rows written before offload existed, rows written under a looser threshold, and large strings nested in tool outputs.

```ts
const result = await session.runMaintenance();

result.messages; // stored rows rewritten
result.parts; // file parts and strings moved to attachment storage
result.bytes; // payload bytes removed from SQLite rows
result.backlogRemains; // another eligible row remains after this pass
```

The pass is lossless. It runs the same offload the write path runs, so bytes move into attachment storage and reconstruct exactly. Nothing is replaced with a marker and nothing is dropped.

Rows within `keepRecentMessages` of the leaf are never touched, so the model's hot window never pays a reconstruction read. One pass rewrites at most `maxMaintenanceRowsPerPass` rows and reschedules itself while a backlog remains. Set `maintenance: false` to turn it off.

Each message row stores the largest payload maintenance could still offload. That number does not depend on the current threshold, so lowering the threshold later still finds older candidates, and rows with no candidates never enter the maintenance content query. A backlog probe reads only an ID rather than another large message.

A completed pass emits the `session:maintenance:completed` telemetry event, and each rewritten row dispatches a `maintenance-rewrite` change-feed event so a cache-owning host can patch its projection. `runMaintenance()` returns `null` when maintenance is disabled or a pass is already running.

## Full-text search

Message search is opt-in because FTS adds writes to every append:

```ts
const sessions = new Sessions({ searchIndexing: true });
const results = await sessions.session().search("deployment failed");
```

With indexing disabled, `search()` throws `SessionSearchDisabledError`. Enabling it on an object with existing messages performs a one-time SQL-only backfill.

Search indexes text parts only. File contents, reasoning, and tool payloads are not indexed automatically.

## Storage economics

On Durable Object SQLite a row write costs roughly 1000 times a row read, so the schema is built to keep one logical write to one billed row.

Every Sessions table is `WITHOUT ROWID` with a composite primary key and no secondary index:

| Table                           | Primary key                      | Contents                                                                                                         |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cf_agents_session_messages`    | `(session_id, id)`               | `seq`, `parent_id`, `type`, `role`, JSON content, token estimate, largest remaining offload candidate, timestamp |
| `cf_agents_session_compactions` | `(session_id, id)`               | Non-destructive summary ranges                                                                                   |
| `cf_agents_session_attachments` | `(session_id, message_id, hash)` | Message-to-payload references                                                                                    |
| `cf_agents_session_config`      | `(session_id, key)`              | Lifted session configuration                                                                                     |
| `cf_agents_session_fts`         | virtual                          | Optional FTS5 index, created only when `searchIndexing` is enabled                                               |

A text append with search disabled bills exactly one row write. The `seq` column carries ordering and `type` distinguishes row kinds, so neither needs an index. The attachment reference table stores only the three key columns, so a reference is the row rather than a row plus an index entry.

State is derived rather than maintained. The active leaf is the session's max-`seq` row, token totals come from per-row stamped estimates, and session summaries are derived from message rows. No counter row, registry row, or refcount is written on the append path.

## Observe changes

`Sessions.subscribe()` reports ordered writes in the active isolate:

```ts
const unsubscribe = sessions.subscribe(async (event) => {
  if (event.sessionId !== "") return;
  switch (event.type) {
    case "append":
    case "update":
    case "maintenance-rewrite":
      await updateLocalProjection(event.message);
      break;
    case "delete":
    case "clear":
    case "compact":
      await refreshProjection();
      break;
  }
});
```

This is a local cache-coherence feed, not a cross-object event log. Capability diagnostics are also emitted through Lifecycle observability.

## Errors

Each error carries a stable `name`, so hosts and tests can classify failures without matching message text.

| Error                            | Thrown when                                                               |
| -------------------------------- | ------------------------------------------------------------------------- |
| `SessionMessageTooLargeError`    | A row still exceeds 1.5 MiB after every offloadable payload has moved out |
| `SessionSerializationError`      | A message is not JSON-serializable                                        |
| `SessionSearchDisabledError`     | `search()` is called without `searchIndexing: true`                       |
| `SessionAttachmentTooLargeError` | One attachment exceeds `maxAttachmentBytes`                               |
| `SessionAttachmentMissingError`  | The `attachments` API is asked for a payload that is not stored           |
| `SessionAttachmentStoreError`    | The configured store failed, wrapped with path and operation context      |

History reads never throw `SessionAttachmentMissingError`. They degrade the part to a marker instead.

## Multiple sessions

Multiple handles can share one Durable Object:

```ts
const support = sessions.session("support");
const sales = sessions.session("sales");
```

Handles are cached, so per-session configuration such as the compaction trigger survives repeated `session()` calls.

`listSessions()` derives summaries from message rows. There is no registry table.

For user-facing chat applications, prefer one Durable Object per conversation. This isolates storage and failure domains and allows conversations to hibernate independently. Use multiple handles inside one object for local branches, drafts, or application-specific namespaces.

## Chat hosts

`Think` and `AIChatAgent` use Sessions internally.

- Think uses branches, compaction, search, Sessions-owned attachment storage, and the change feed. Its prompt context comes from [`agents/context`](./context.md).
- AIChatAgent uses the default handle as a linear chain. Its existing destructive regeneration, mutable `messages` array, retention option, and wire protocol remain unchanged. Attachment storage is opt-in through `sessionAttachments`.

Existing `assistant_*` Session tables and `cf_ai_chat_agent_messages` are lifted automatically. Legacy tables are renamed to `*__lifted_v1` tombstones for one release so rollback remains possible.

## Memory boundaries and future streaming

The capability streams history and attachments, but some consumers still require arrays.

| Operation                                 | Current shape                                 | Future direction                                                                                 |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| History export, indexing, maintenance     | Stream or bounded batches                     | Already streamable                                                                               |
| Tool-call lookup and reconciliation scans | Host-specific arrays in current chat packages | Can scan batches and stop early                                                                  |
| Model request input                       | AI SDK message array                          | Must materialize a bounded model window                                                          |
| Compaction summarizer input               | Message array                                 | Must materialize a bounded compaction range                                                      |
| Legacy full-transcript client snapshots   | Message array                                 | Can move to paginated history plus live deltas                                                   |
| Attachment delivery                       | `ReadableStream`                              | Already streamable                                                                               |
| Attachment hashing on write               | Incremental stream                            | Declared-length large streams go directly to R2; unknown lengths stage in bounded SQLite windows |

The chat packages retain their current public arrays and wire behavior in this release. Moving reconciliation and client history protocols to streaming requires separate protocol work.

See `examples/next/sessions` for a runnable server-only example, and `examples/next/sessions-slam` for the deployed measurement harness.
