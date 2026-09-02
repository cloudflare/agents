# Sessions

> **Experimental.** Everything exported from `agents/sessions` may change between releases while the API stabilizes.

`agents/sessions` stores durable conversation history in a [Lifecycle Object](./lifecycle.md). It provides tree-structured messages, streamed and byte-budgeted reads, compaction overlays, optional full-text search, and lossless payload storage.

**Sessions stores messages. It is not a file store.** Media you attach to a message is kept out of the message row and stored separately, addressed by content, and put back verbatim when you read. That keeps a message row small however large its attachments are — but it does not reclaim database space, because the payload lives in the same Durable Object. A Durable Object's 10 GB ceiling is therefore the real bound on how much media one conversation can hold: roughly 39,000 200 KB images, measured. An application that handles files should keep them in a file store and put a reference in the message. Think does exactly that with its [Workspace](../think/index.md), which spills to R2.

Prompt assembly lives in [`agents/context`](./context.md) and composes with a session handle rather than living inside it.

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
```

An append without `parentId` attaches to the active leaf. Pass `null` to create a root or pass a message ID to create a branch:

```ts
await this.session.appendMessage(alternativeReply, {
  parentId: userMessage.id
});
```

Every write runs the same pipeline: sanitize provider metadata, strip reserved metadata on client input, then commit the row and any continuation rows in one synchronous SQLite transaction.

Mark untrusted input with `source: "client"`:

```ts
const sessions = new Sessions({
  reservedMetadataKeys: ["channel", "turnMetadata"]
});

await sessions.session().appendMessage(clientMessage, {
  source: "client"
});
```

This strips reserved metadata keys. It does not limit message size — see [There is no upper bound on a message](#there-is-no-upper-bound-on-a-message).

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

Sessions stores messages. One SQLite row holds up to `MAX_INLINE_ROW_BYTES` (1.5 MiB) of serialized JSON, which is more than the overwhelming majority of messages need: they occupy exactly one row, and cost exactly one billed row write.

A message that does not fit is split across continuation rows and reassembled on read. Nothing is truncated, nothing is summarized, and no message is too large to store — a 5 MB message is one message row plus three continuation rows, and reads back byte for byte. There is no error to catch and nothing to configure.

Slices are cut on UTF-8 **byte** boundaries, never in the middle of a surrogate pair, so a message full of emoji or CJK text round-trips exactly like an ASCII one.

### There is no upper bound on a message

This is a deliberate position, not an omission: Sessions imposes no maximum message size. A message is split across as many continuation rows as it needs, so a single very large write can consume a meaningful share of the Durable Object's 10 GB.

Bounding the size of untrusted input is the application's job. In particular, `appendMessage(message, { source: "client" })` sanitizes provider metadata and strips reserved metadata keys — it does **not** limit size. If clients can write to a session, check the size of what they send before you append it.

An application that handles files should keep them in a file store (R2, or the Workspace) and put a reference in the message.

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

The budget counts what hydration actually costs. Each row is charged its full stored size — the message row plus every continuation row it was split across — so a 12 MB message is charged 12 MB, not the 1.5 MiB its first slice occupies. That is what makes the budget a bound on isolate memory.

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

`getHistoryRowStats()` returns per-row stored bytes (row plus continuation rows) and stamped token estimates, without loading message content. `stats()` derives path length, stored content bytes, and a heuristic token estimate for the active path with compaction overlays applied.

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

Forked messages receive new IDs, continuation rows and all. Compaction overlays are not copied.

To move a conversation between Durable Objects, export the source with `history()` and replay it with `importMessage()` on the destination:

```ts
let parentId: string | null = null;
for await (const message of source.history()) {
  await destination.importMessage(message, {
    parentId,
    createdAt: message.createdAt?.getTime() ?? Date.now()
  });
  parentId = message.id;
}
```

`importMessage()` writes one historical message verbatim: explicit parent and timestamp, no change-feed event. It splits over-budget messages the same way an append does.

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

Sessions stamps each message with a token estimate when the row is written. `compactAfter()` gates on that O(1) aggregate and never reads the transcript to decide whether to compact. Auto-compaction failures are non-fatal: they log, emit `session:error`, and leave the transcript alone.

To trim a transcript before handing it to a model, `truncateOlderMessages` is exported from [`agents/chat`](./chat-agents.md), not from `agents/sessions`.

## Large messages

A message is stored as one JSON string. When that string exceeds the row budget it is cut into slices: slice 0 lives in the message row, the rest become numbered continuation rows in `cf_agents_session_message_chunks`. A read concatenates them back, so what you append is exactly what you read.

This is invisible from the outside. There is no pointer, no reconstruction mode, and no read option:

```ts
await session.appendMessage(message); // any size
const stored = await session.getMessage(message.id); // byte-identical
```

The common path pays nothing for it. A window of messages with no continuations issues exactly the same queries it always did; the extra query for continuation rows runs only for the ids in the window that actually have them.

### What it costs

Splitting is not a way to shrink the database. Continuation rows live in the same Durable Object as the message they belong to, inside the same 10 GB. Billing counts rows written, not bytes, so a 500 KB message costs the same one billed row as a tiny one, and a 2 MB message costs two.

`SessionRowStat.bytes` and `SessionStats.totalContentBytes` report the whole message — row plus continuations — so a byte budget passed to `getRecentHistory()` bounds the memory a hydration will actually take.

### Files belong in a file store

Sessions is a message store, not a file store. Attaching a file is convenient and exact, but it is stored in the conversation forever and counted against the Durable Object's 10 GB. An application that handles files should write them to R2 or the Workspace and put a path or URL in the message instead.

## Attachments

A part that declares a non-text media type and carries its bytes inline — an image, an audio clip, a PDF — is stored outside the message. The part keeps its shape and its `mediaType`; only the payload is replaced, by an `attachment:sha256:<hex>` pointer. Reads put the payload back, so this is invisible unless you ask to see it:

```ts
await session.appendMessage(messageWithImage);
const stored = await session.getMessage(messageWithImage.id); // byte-identical
```

The rule is about **type, not size**. An image is stored this way whether it is 8 KB or 8 MB, and text is never stored this way at any size — long prose is split across continuation rows instead. The two mechanisms never interact: media leaves the message before the row is measured, so a message carrying a large image usually has no continuation rows at all.

To see the pointers rather than the payloads — when scanning a transcript, or assembling context where materializing megabytes would be wasted — read in pointer mode:

```ts
const history = await session.getHistory({ attachments: "pointer" });
// parts carry url: "attachment:sha256:…" and their original mediaType
```

Identical payloads are stored once. That is a consequence of addressing bytes by their hash, which mainly means a retried write costs nothing; do not rely on it as a space optimization.

A payload lives as long as some message references it. Deleting the last message that points at one deletes the bytes; clearing a session deletes all of them.

### What it costs

Keeping media out of the message is not free. A 200 KB image bills four row writes — the message, one payload chunk, its metadata, and one reference — where inlining it would bill one. A 2 MiB image bills five. Text messages are unaffected and still bill exactly one row.

What you get is a message row that stays a few hundred bytes however large the payload is. `SessionRowStat.bytes` still charges each message for the payloads it points at, so the byte budget you pass to `getRecentHistory()` remains a bound on the memory a hydration actually takes.

That budget is a hard ceiling with no message-count floor beneath it. `getRecentHistory()` returns the longest recent suffix that fits, and always at least the newest message; a window of unusually large messages is simply shorter. A floor that admitted rows regardless of size would defeat the bound it sits under, which is why there is no longer a `minRecentMessages` argument.

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

| Table                              | Primary key             | Contents                                                                                        |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `cf_agents_session_messages`       | `(session_id, id)`      | `seq`, `parent_id`, `type`, `role`, JSON content, continuation count, token estimate, timestamp |
| `cf_agents_session_message_chunks` | `(session_id, id, idx)` | Continuation slices of a message too large for one row                                          |
| `cf_agents_session_compactions`    | `(session_id, id)`      | Non-destructive summary ranges                                                                  |
| `cf_agents_session_config`         | `(session_id, key)`     | Lifted session configuration                                                                    |
| `cf_agents_session_fts`            | virtual                 | Optional FTS5 index, created only when `searchIndexing` is enabled                              |

A text append with search disabled bills exactly one row write. The `seq` column carries ordering and `type` distinguishes row kinds, so neither needs an index. A continuation row carries its slice and nothing else — no hash, no media type, no size — so an over-budget message costs one billed row per slice and nothing more.

State is derived rather than maintained. The active leaf is the session's max-`seq` row, token totals come from per-row stamped estimates, and session summaries are derived from message rows. No counter row, registry row, or refcount is written on the append path.

## Observe changes

`Sessions.subscribe()` reports ordered writes in the active isolate:

```ts
const unsubscribe = sessions.subscribe(async (event) => {
  if (event.sessionId !== "") return;
  switch (event.type) {
    case "append":
    case "update":
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

| Error                        | Thrown when                                         |
| ---------------------------- | --------------------------------------------------- |
| `SessionSerializationError`  | A message is not JSON-serializable                  |
| `SessionSearchDisabledError` | `search()` is called without `searchIndexing: true` |

There is no "message too large" error. A message that exceeds the row budget is split across continuation rows instead.

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

- Think uses branches, compaction, search, and the change feed. Its prompt context comes from [`agents/context`](./context.md). Aged media leaves the conversation through Think's own media eviction, which is a context-window technique and unrelated to how Sessions stores a row.
- AIChatAgent uses the default handle as a linear chain. Its existing destructive regeneration, mutable `messages` array, retention option, and wire protocol remain unchanged.

Existing `assistant_*` Session tables and `cf_ai_chat_agent_messages` are lifted automatically, then dropped once every row is verified copied.

## Memory boundaries and future streaming

The capability streams history, but some consumers still require arrays.

| Operation                                 | Current shape                                 | Future direction                               |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| History export and indexing               | Stream or bounded batches                     | Already streamable                             |
| Tool-call lookup and reconciliation scans | Host-specific arrays in current chat packages | Can scan batches and stop early                |
| Model request input                       | AI SDK message array                          | Must materialize a bounded model window        |
| Compaction summarizer input               | Message array                                 | Must materialize a bounded compaction range    |
| Legacy full-transcript client snapshots   | Message array                                 | Can move to paginated history plus live deltas |

The chat packages retain their current public arrays and wire behavior in this release. Moving reconciliation and client history protocols to streaming requires separate protocol work.

See `examples/next/sessions` for a runnable server-only example.
