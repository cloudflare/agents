# Sessions

> **Experimental.** Everything exported from `agents/sessions` may change between releases while the API stabilizes.

`agents/sessions` stores durable conversation history in a [Lifecycle Object](./lifecycle.md). It provides tree-structured messages, streamed and byte-budgeted reads, compaction overlays, optional full-text search, context blocks, and file attachment offload.

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

Writes run the same storage hygiene used by the chat packages. Sessions removes ephemeral provider metadata, enforces the SQLite row ceiling, and replaces configured file payloads with pointers before committing the row.

Mark untrusted input with `source: "client"`:

```ts
const sessions = new Sessions({
  reservedMetadataKeys: ["channel", "turnMetadata"]
});

await sessions.session().appendMessage(clientMessage, {
  source: "client"
});
```

This strips reserved metadata and rejects attachment pointers that the client cannot legitimately echo from the same session.

Other writes:

```ts
await session.updateMessage(message);
await session.upsertMessage(message);
await session.appendMany(messages);
await session.deleteMessages([messageId]);
await session.clearMessages();
```

Deleting a message splices its children to its parent. Removing a message in the middle of a chain does not make older history unreachable.

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
await session.getPathLength();
await session.getHistoryRowStats();
await session.stats();
```

`getHistoryRowStats()` does not load message content. `stats()` derives path length, stored content bytes, attachment bytes, and a heuristic token estimate.

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

Forked messages receive new IDs. Content-addressed attachment blobs are shared through new reference rows rather than copied.

For one-Durable-Object-per-conversation applications, keep the conversation directory in a parent or router Durable Object. Export the source with `history({ reconstruct: "pointer" })`, import through the internal migration seam or an application RPC, and copy blobs only when the two objects do not share an attachment namespace.

## Compaction

Compaction overlays replace a range at read time without deleting the original rows:

```ts
import { createCompactFunction } from "agents/sessions";

session
  .onCompaction(
    createCompactFunction({
      summarize: async (prompt) => summarize(prompt),
      tailTokenBudget: 20_000,
      minTailMessages: 2
    })
  )
  .compactAfter(80_000);
```

Run it explicitly:

```ts
await session.compact();
```

Or store an already-produced summary:

```ts
await session.addCompaction(summary, fromMessageId, toMessageId);
```

Sessions stamps each message with a token estimate. The automatic threshold checks that aggregate without loading message content. A custom `tokenCounter` is consulted only after the cheap estimate crosses the threshold.

## Store attachments outside message rows

File parts can contain data URLs:

```ts
{
  type: "file",
  mediaType: "image/png",
  filename: "screen.png",
  url: "data:image/png;base64,..."
}
```

Enable attachment extraction to replace payloads above a threshold with `attachment:sha256:<hash>`:

```ts
import { Sessions } from "agents/sessions";

readonly sessions = new Sessions({
  attachments: {
    inlineThresholdBytes: 32 * 1024,
    r2: () => this.env.ATTACHMENTS,
    r2ThresholdBytes: 1_500_000
  }
});
```

Sessions owns the payload tables, private R2 keys, message references, deduplication, and deletion. Workspace is not part of attachment durability.

Without R2, Sessions stores every extracted payload in Durable Object SQLite. With R2, payloads below `r2ThresholdBytes` stay in SQLite and larger payloads use one private R2 object.

SQLite payloads are split into 1.5 MiB rows. Each read pulls one row by `(storage_id, chunk_index)`. The final row can be shorter.

The write order is:

1. Decode and hash the payload incrementally.
2. Reuse an existing whole-file hash or write a new payload.
3. Commit the message, optional FTS row, and attachment references in one SQLite transaction.

A committed pointer therefore has durable bytes behind it.

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

The returned pointer is a durable standalone resource. Sessions does not delete it merely because no message references it yet. The caller owns inserting `part` into a message. If it is no longer needed, delete it explicitly:

```ts
await sessions.attachments.delete(part.url);
```

`delete()` returns `false` while any stored message still references the hash.

Sessions does not run an age-based unreferenced-blob sweep. Coupled message writes clean up payloads they created when the message write fails or loses a race. They never infer that a pre-existing standalone payload is abandoned.

Serialize low-level `attachments.delete(pointer)` against inserting that same standalone pointer. Think and AIChatAgent already serialize their chat mutations.

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

The default restores an AI SDK data-URL file part:

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

A reconstructor receives lazy byte access:

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

## Aged media maintenance

Aged maintenance handles inline media written by older releases and large strings nested in tool outputs:

```ts
const sessions = new Sessions({
  attachments: {
    keepRecentMessages: 8,
    maxEvictionRowsPerPass: 64,
    evictionThresholdBytes: 32 * 1024
  }
});

await sessions.session().evictAgedMedia();
```

Each message stores the largest payload that maintenance could rewrite. The value does not depend on the current threshold, so lowering the threshold later still finds older candidates. Rows with no media candidates never enter the maintenance content query.

The pass reads a bounded number of candidates, writes payloads before changing messages, and uses content compare-and-swap. A backlog probe reads only an ID rather than another large message.

Set `preserveEvicted: false` only when permanent data loss is intentional. The default preserves bytes in Sessions storage.

## Full-text search

Message search is opt-in because FTS adds writes to every append:

```ts
const sessions = new Sessions({ searchIndexing: true });
const results = await sessions.session().search("deployment failed");
```

With indexing disabled, `search()` throws `SessionSearchDisabledError`.

Search indexes text parts only. File contents, reasoning, and tool payloads are not indexed automatically.

## Context blocks and skills

The Session handle includes the context API used by Think:

```ts
const session = sessions
  .session()
  .withContext("soul", {
    provider: { get: async () => "You are a helpful assistant." }
  })
  .withContext("memory", {
    description: "Facts learned about the user",
    maxTokens: 1_100
  })
  .withCachedPrompt();

const tools = await session.tools();
const system = await session.freezeSystemPrompt();
```

A provider with `get()` is read-only. Add `set()` for writable context, `load()` for lower-level loadable context, or `search()` for searchable context. `R2SkillProvider`, `AgentContextProvider`, and `AgentSearchProvider` are exported from `agents/sessions`.

First-class Agent Skills live in `agents/skills`. Think projects each resolved `SKILL.md` into the active workspace by default:

- Computer: `/workspace/.agents/skills/<name>/SKILL.md`
- legacy Shell: `/.agents/skills/<name>/SKILL.md`

Workspace edits affect later activation and resource reads. Think records a durable source fingerprint, so an unchanged cold wake does not stat or rewrite every skill file. Skill resources copy into the workspace on first use rather than during startup. Set `skillWorkspace = false` to keep source-only loading, or set `skillWorkspace.root` for a custom proxy path.

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

## Multiple sessions

Multiple handles can share one Durable Object:

```ts
const support = sessions.session("support");
const sales = sessions.session("sales");
```

`listSessions()` derives summaries from message rows. There is no SessionManager registry.

For user-facing chat applications, prefer one Durable Object per conversation. This isolates storage and failure domains and allows conversations to hibernate independently. Use multiple handles inside one object for local branches, drafts, or application-specific namespaces.

## Chat hosts

`Think` and `AIChatAgent` use Sessions internally.

- Think uses branches, compaction, context blocks, search, Sessions-owned attachment storage, workspace-projected Agent Skills, and the change feed.
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

See `examples/next/sessions` for a runnable server-only example.
