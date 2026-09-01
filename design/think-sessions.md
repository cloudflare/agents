# Think and Sessions

Think stores conversation history through the `agents/sessions` Lifecycle capability.

The original Phase 1 design in this file described the pre-capability `agents/experimental/memory/session` implementation. [rfc-sessions.md](./rfc-sessions.md) superseded that storage design. The current shared architecture is documented in [sessions.md](./sessions.md).

## Current composition

Think owns two chat-related capabilities:

```ts
readonly sessions = new Sessions({
  attachments: () => ({
    ...this.sessionAttachments,
    inlineThresholdBytes: () => this.mediaEvictionThreshold(),
    keepRecentMessages: () => this.mediaEvictionKeepRecent()
  }),
  reservedMetadataKeys: ["channel", "turnMetadata"],
  searchIndexing: true,
  missingUpdate: "ignore"
});

readonly streams = createChatStreams();

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  this.lifecycle.use(this.sessions);
  this.lifecycle.use(this.streams);
}
```

Sessions stores settled conversation messages. Streams stores in-flight output and recovery evidence. Neither capability imports the other.

`configureSession(session)` configures the default handle with context blocks, prompt freezing, compaction, and skills. Think subscribes to Sessions changes to keep its existing in-isolate `messages` array coherent.

## Attachments

Sessions owns attachment bytes in chunked SQLite with an optional R2 tier. A large AI SDK file part becomes a content-addressed pointer in the message row. The default read reconstructs the data URL, so Think's existing model and client behavior does not change. Workspace is independent operational storage for tools and projected Agent Skills.

Aged media maintenance moved out of Think. Sessions now owns row selection, blob-before-row ordering, compare-and-swap rewrites, garbage collection, and bounded continuation passes. Think retains the `mediaEviction` property as host policy and re-emits `chat:media:evicted` for compatibility.

The explicit `externalizeToWorkspace: false` mode remains lossy. The property name is retained for compatibility; the default now preserves bytes in Sessions storage rather than Workspace.

## Branches

Think appends a regenerated assistant message under the same user parent. The prior response remains stored. `getBranches(parentId)` lists alternatives, and `getHistory({ leafId })` selects one path.

## Context and compaction

The Session handle owns Think's context API:

- `withContext()` and `addContext()`
- `withCachedPrompt()` and `freezeSystemPrompt()`
- `tools()` for writable, searchable, and loadable context
- `onCompaction()` and `compactAfter()`

Compaction overlays replace old spans at read time without deleting original messages.

## Memory behavior

Think's behavior is intentionally unchanged by the storage migration. Its startup hydration uses `getRecentHistory(hydrationByteBudget, 4)`, but reconciliation, current client snapshots, and model assembly still use arrays.

Future work can stream reconciliation scans and tool-call lookup. Model input and compaction must still materialize bounded arrays because their downstream APIs require them. This work is tracked in [sessions.md](./sessions.md), not hidden inside the replatform.

## Multi-chat applications

The primary architecture is a directory Durable Object plus one Think Durable Object per conversation. Each conversation installs its own Sessions capability. Facets remain appropriate for subagents and generated-code work with isolated SQLite.

Named Session handles remain available, but SessionManager and its in-object conversation registry were removed.
