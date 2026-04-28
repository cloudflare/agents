# Inline sub-agent event streaming — design notes

## Why this doc exists

Issue [#1377](https://github.com/cloudflare/agents/issues/1377)
("`ResumableStream` is hardcoded to chat use case") looks on its surface
like a small library cleanup: two literals in one file, two optional
constructor arguments, ~20-line patch. Defaults preserve back-compat,
non-chat callers pass distinct values, ship.

Reading carefully, the issue is the visible tip of a much bigger missing
piece: **first-class sub-agents that participate inside a single chat
turn, with their lifecycle events streaming back into that turn's UI in
real time.** The OP hit `ResumableStream`'s hardcoding because it is the
nearest piece of generic-shaped infra in the framework, and the
"durably stream chunks over WS, with replay on reconnect" abstraction is
what anyone building this pattern would reach for first.

This note captures:

- what the OP is actually building (in plain language)
- the gap between what we ship as "sub-agents" today and what the OP
  needs
- why the two-line fix from #1377 is correct but insufficient
- the full design surface, in concentric rings
- a concrete staged plan that ships the cheap fix now without
  prejudicing the larger design
- the open questions that the larger design has to answer

It is intentionally provisional. The smallest part — the durable
multi-channel primitive — feels close to decided. Everything above it
is a real design problem and probably wants a proper RFC eventually.

## Terminology — "sub-agent" is overloaded

The same word means two different things in this repo and being
sloppy about it has been a source of confusion:

1. **Sub-agent as nested addressable Durable Object** (what we ship).
   Documented in `docs/sub-agents.md`:

   > Sub-agents are child Durable Objects colocated under a parent
   > agent. Each sub-agent has its own isolated SQLite storage and its
   > own WebSocket connections … Clients reach a sub-agent directly
   > via a nested URL.

   API surface: `subAgent(Cls, name)`, `parentAgent(Cls)`,
   `useAgent({ sub: [...] })`, `onBeforeSubAgent`, `hasSubAgent`,
   `listSubAgents`. URL shape: `/agents/inbox/<userId>/sub/chat/<chatId>`.
   The browser picks one and connects directly to it.

   Suggested use cases (verbatim from the doc): "chats, documents,
   sessions, shards, projects" — i.e. **siblings the user navigates
   between**, each with their own UI. `examples/multi-ai-chat` and
   `examples/assistant` are the canonical demonstrations.

2. **Sub-agent as turn-scoped helper** (not shipped). The Claude
   Code / Cursor / Devin pattern: you're in one chat, the assistant
   decides to dispatch helper agents to do tool work in parallel, and
   their lifecycle events — started, called this tool, produced this
   artifact, finished — stream back into the **same** chat's UI as
   the turn unfolds.

The two are different in almost every important dimension:

|                     | Nested addressable (shipped)  | Turn-scoped helper (unshipped)    |
| ------------------- | ----------------------------- | --------------------------------- |
| Lifetime            | Long-lived (a whole chat)     | Per-turn (or persistent, TBD)     |
| WS termination      | At the child                  | At the parent                     |
| User picks one?     | Yes (sidebar / URL)           | No (parent dispatches)            |
| Identity in UI      | Top-level conversation        | Inline part of the parent message |
| Number active       | One at a time per browser tab | Many in parallel per turn         |
| Event surface       | Whatever the child broadcasts | Typed lifecycle / progress events |
| Replay on reconnect | Single chat stream            | Multiple concurrent streams       |

When the OP says "sub-agent event streaming on a Think-based DO," they
mean sense (2). When the framework documentation says "sub-agent," it
means sense (1). The shipped routing primitive is necessary for (2)
because helpers still want to be addressable Durable Objects with their
own state — but it isn't sufficient, because (2) needs the parent DO to
multiplex helper events onto its own WebSocket, not have the browser
navigate to the helper.

Throughout the rest of this doc, "helper" = sense (2),
"sub-agent (routing)" = sense (1). The framework public name for sense
(2) is TBD. Calling them "helpers" here is internal shorthand.

## What the OP is actually trying to do

Stripped of framework language:

> I'm building an agent where, when you chat with it, behind the
> scenes it spawns helper agents (other agents doing tool work) and I
> want those helpers' progress events to stream back into the browser
> UI in real time.

The browser has one WebSocket open to the parent. So both:

1. the normal chat reply stream from the LLM, and
2. the helper event stream

have to flow over that same socket, from that same Durable Object.

The OP wanted to reuse `ResumableStream` for (2) because it already
solves their hard problem: refresh the page mid-turn → you should see
helper progress catch up, not vanish. Helper events, like LLM tokens,
need durable buffering and replay-on-reconnect.

That's what the issue body actually says, just phrased as a complaint
about hardcoded literals. The literals are blocking the OP from
running a second `ResumableStream` instance on the same DO for helper
events. They worked around it by hand-rolling parallel SQL + replay
plumbing, reinventing `ResumableStream`'s batched writes, row-size
guard, and stale-stream cleanup in the process.

## Current state of `ResumableStream`

Last touched in [#1237](https://github.com/cloudflare/agents/pull/1237)
(the chat-shared-layer extract). Untouched since then despite a flurry
of adjacent activity (see "Why recent work doesn't address this" below).
The hardcoded literals from the issue are present verbatim.

The two collisions:

1. **SQL tables are hardcoded.** `cf_ai_chat_stream_chunks` and
   `cf_ai_chat_stream_metadata` appear as literal strings in 24
   places across the file (table creation, all CRUD, `restore()`,
   `clearAll()`, `destroy()`, `_maybeCleanupOldStreams`). Two
   instances on the same `this.sql` would interleave their rows,
   `restore()` would pick up whichever instance happened to have the
   most recent `status='streaming'` row, and `clearAll()` from one
   would wipe the other.

   ```86:103:packages/agents/src/chat/resumable-stream.ts
       this.sql`create table if not exists cf_ai_chat_stream_chunks (
         id text primary key,
         stream_id text not null,
         body text not null,
         chunk_index integer not null,
         created_at integer not null
       )`;

       this.sql`create table if not exists cf_ai_chat_stream_metadata (
         id text primary key,
         request_id text not null,
         status text not null,
         created_at integer not null,
         completed_at integer
       )`;
   ```

2. **Replay wire type is hardcoded.** All four `connection.send()`
   calls inside `replayChunks` stamp every frame with
   `type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE`. The browser's chat
   hook listens on that exact tag and tries to decode the body as
   chat content — so a non-chat consumer sharing the same WS would
   collide on the client side too.

   ```297:307:packages/agents/src/chat/resumable-stream.ts
       for (const chunk of chunks || []) {
         connection.send(
           JSON.stringify({
             body: chunk.body,
             done: false,
             id: requestId,
             type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
             replay: true
           })
         );
       }
   ```

The constructor takes only `sql`:

```84:107:packages/agents/src/chat/resumable-stream.ts
  constructor(private sql: SqlTaggedTemplate) {
    // Create tables for stream chunks and metadata
    this.sql`create table if not exists cf_ai_chat_stream_chunks (
```

So the OP's diagnosis holds in code, today.

## Why recent work doesn't address this

Several PRs in the last week landed work _adjacent_ to resumable
streaming. None of them touched `resumable-stream.ts`:

- **[#1374](https://github.com/cloudflare/agents/pull/1374)** —
  "resume-stream stability fixes." Sounds related; isn't quite. It
  fixed Think's `onConnect` broadcasting `CHAT_MESSAGES` mid-stream
  (which was overwriting the in-progress assistant message after a
  refresh). Side benefit: `_resumableStream` was promoted from
  `private` to `protected` on both `AIChatAgent` and Think. That
  helps subclasses _coordinate around_ the resume lifecycle, but
  even a subclass instantiating a second `ResumableStream` still
  collides on the literal table names and frame type. Visibility
  was the wrong axis.
- **[#1384](https://github.com/cloudflare/agents/pull/1384)** —
  multi-session assistant. Settled that one chat conversation lives
  in one child DO, browser connects directly to the child via
  `useAgent({ sub: [...] })`. In that pattern the parent DO doesn't
  run a Think chat at all, so the collision the OP describes doesn't
  arise _for that architecture_. But the OP's architecture is
  exactly the opposite — the parent terminates the WS _because_ it
  needs to multiplex helper events into the user's only chat thread.
  #1384 is "you don't need to do that," not "we made that work."
- **[#1393](https://github.com/cloudflare/agents/pull/1393)** —
  facet bootstrap via explicit `FacetStartupOptions.id`. Unrelated.
- **[#1394](https://github.com/cloudflare/agents/pull/1394)** —
  Think `beforeStep` hook + `TurnConfig.output` passthrough.
  Unrelated.
- **[#1395](https://github.com/cloudflare/agents/pull/1395)** —
  `SubmitConcurrencyController` lifted into `agents/chat`. Doesn't
  touch the stream class.
- **[#1396](https://github.com/cloudflare/agents/pull/1396)** —
  `message-reconciler.ts` moved into `agents/chat`. Doesn't touch
  the stream class.

The post-#1384 chat-shared-layer growth pattern (PRs #1393–#1396)
is consistent with what one would expect: each cross-cutting fix
that _both_ AIChatAgent and Think need migrates from `ai-chat` into
`agents/chat`. Helper streaming is the next obvious thing for that
layer to absorb, and `ResumableStream` is already living in
`agents/chat` waiting for its second consumer.

## What's shipped vs unshipped

To make the gap concrete:

**Shipped:**

- Routing primitive: `subAgent(Cls, name)`, `parentAgent(Cls)`,
  `onBeforeSubAgent`, `hasSubAgent`, `listSubAgents`,
  `useAgent({ sub: [...] })`. Documented in `docs/sub-agents.md`.
- Resumable streaming for the parent's _own_ chat reply, durable
  across reconnect / hibernation. One `ResumableStream` per Think
  / AIChatAgent DO.
- Per-DO SQLite, isolated in colocated facets.
- Multi-session assistant pattern (sense (1)) — kitchen-sink
  reference in `examples/assistant`, minimal proof in
  `examples/multi-ai-chat`.

**Unshipped:**

- Multi-channel durable streaming on a single DO. Today
  `ResumableStream` is single-instance / single-channel; running N
  durable streams on one DO requires either subclassing tricks
  (broken by the literal SQL tables) or hand-rolled SQL.
- A typed event vocabulary for helpers. No `helper-started`,
  `helper-progress`, `helper-finished` shape; no defined relationship
  between helper events and AI SDK `UIMessagePart`.
- A parent-side API for "spawn this helper, attach its event stream
  to the current turn." Today you can `subAgent(Helper, id)` and RPC
  it, but events come back via DO-RPC return values, not a live
  stream into the turn.
- A client-side concept of "events that belong to this turn but came
  from a helper." `useAgentChat` knows about its own message parts;
  it doesn't have a slot for a helper's progress.
- Cancellation propagation. Aborting a Think turn does not implicitly
  cancel sub-agent RPCs the turn started.
- Auth / quota / retention boundaries for helpers.

## What the small fix from #1377 buys us

The OP proposed two optional constructor arguments, both back-compat:

```ts
class ResumableStream {
  constructor(
    sql: SqlTaggedTemplate,
    options?: { tablePrefix?: string; messageType?: string }
  );
}
```

- `tablePrefix` defaults to `"cf_ai_chat_"`.
- `messageType` defaults to `CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE`.

Existing chat callers preserve byte-identical behavior. A second
instance on the same DO can pick a non-colliding prefix and a
non-colliding message type and coexist with the first.

This is the minimum legal repair. It's correct and we should ship
it (probably in a slightly cleaner form — see Ring 1 below). But on
its own it leaves the actual feature ("helper events streaming into
a turn") entirely DIY for every consumer, who would each independently
have to:

- pick a table prefix and a wire-type tag
- wire up start/append/complete on the parent DO
- design their own helper event schema
- teach their client code to demux the second wire type
- handle cancellation / cleanup / retention by hand
- reinvent the integration with `useAgentChat`'s message lifecycle

i.e. the value-add is approximately "you can now pay all the same
costs the OP paid, without colliding with the chat tables." That's
genuinely useful as an unblock, and it leaves enough room above it
to do the design properly. But it isn't the design.

## Design pivot: helpers-as-sub-agents with parent-forwarding (2026-04-27)

The original design captured below (multi-channel `ResumableStream`
on the parent DO, helpers reporting events back into a parent-owned
channel) was the obvious "fix #1377 cleanly" path. After working
through it concretely, including building `examples/agents-as-tools`
v0 and stepping back to compare alternatives, we landed on a
different design that's a better foundation for everything above
the streaming primitive.

**The pivot:** helpers are real sub-agents (each its own DO with
its own `ResumableStream`), the browser keeps one WebSocket to
whatever DO it normally connects to, and the **parent forwards**
helper events from the helper's stream onto its own WS while a tool
execute is in flight. The parent maintains a tiny `active_helpers`
table so it can replay each in-flight helper's stored events on
reconnect.

What this changes vs. the original "multi-channel on parent" plan:

|                          | Original (multi-channel)                | Pivot (helpers as sub-agents + forward) |
| ------------------------ | --------------------------------------- | --------------------------------------- |
| Helper state location    | Parent DO                               | **Helper's own DO**                     |
| Browser WSes per session | 1                                       | 1                                       |
| Drill-in detail view     | Needs new API on parent                 | **Free — routing primitive**            |
| `ResumableStream` shape  | Multi-channel, schema migration         | **Single-channel, one ctor option**     |
| Persistent helpers later | Needs new TTL machinery on parent       | **Free — helpers outlive the run**      |
| Parallel helpers         | All write back through parent's isolate | **Each helper writes locally**          |
| Tables on parent         | `chat` + `helper-events` channels       | Just `chat` (unchanged)                 |
| Replay-on-reconnect      | Trivial (parent has all state)          | One extra step (parent re-fetches)      |

Cost: a small reconnect-replay step on the parent (track active
helpers, on reconnect query each helper's stored events and forward
to the connecting client). Live event flow continues through
`broadcast()` while the tool execute is running.

The decisive points:

1. **State containment.** A helper's events are about the helper's
   work, not the chat's. Putting them on the helper's DO is the
   honest representation. Persistent / inspectable / drill-in-able
   helpers are a natural extension; they aren't with parent-side
   storage.
2. **Reuses the routing primitive instead of inventing.** Drill-in,
   addressing, lifecycle, parent/child RPC — all already shipped.
   The helper inherits all of that for free.
3. **Smaller framework change.** One ctor option (`messageType`)
   instead of multi-channel schema + per-channel state machine.
   Tables don't need to be parameterized because each DO has its
   own SQLite — collisions are impossible by isolation, not by
   prefix.
4. **Multi-ai-chat-compatible.** The pattern is recursive: the WS
   terminus may be a top-level agent (agents-as-tools) or itself a
   sub-agent (multi-ai-chat's `Chat` is a child of `Inbox`). In
   either case, helpers are children of whoever terminates the WS,
   and the same forwarding pattern applies.

What gets parked: **the multi-channel `ResumableStream` design**.
It's not killed — if a future use case genuinely wants one DO to
multiplex N independent durable streams to its own clients (e.g. a
workflow DO with multiple parallel tracks, where the streams
genuinely belong to the same DO), the design captured below is the
shape it would take. For helpers specifically, it's the wrong tool.

What this means for the rings:

- **Ring 1** shrinks from "multi-channel `ResumableStream`" to "add
  `messageType` ctor option to `ResumableStream`" (~10 LOC).
- **Ring 4** ("client rendering / drill-in") moves from "future,
  optional" to "central, free via the existing routing primitive."
- **Ring 3** (parent-side API) gets simpler — `helperTool(Cls)` is
  now sugar over `subAgent` + `startAndStream` + `broadcast`.
- **Rings 2, 5, 6** unchanged in spirit, simpler in mechanics.

The "concentric rings" section below is preserved as a record of
the original design space we explored. The Stage 1 / Stage 2 plans
later in the doc are the ones that reflect the pivot.

## The full design surface, in concentric rings

Six rings. Each adds capability over the one below. Ring 1 is the
plumbing; Rings 2–4 are the helper protocol; Rings 5–6 are the
finishing touches.

### Ring 1 — multi-channel durable streaming primitive

What `ResumableStream` is _trying_ to be and isn't quite.

Not the OP's two ctor args verbatim. The cleaner generalization:
**one DO, N named channels.**

API sketch:

```ts
class DurableStreamChannels {
  constructor(
    sql: SqlTaggedTemplate,
    options?: {
      tablePrefix?: string; // defaults to "cf_durable_stream_"
    }
  );

  // start a new stream on a named channel
  start(channelId: string, requestId?: string): string;

  // append to a stream
  storeChunk(channelId: string, streamId: string, body: string): void;

  // complete or error a stream
  complete(channelId: string, streamId: string): void;
  markError(channelId: string, streamId: string): void;

  // replay all active streams on a connection, optionally filtered
  // by channel subscription
  replayChunks(
    connection: Connection,
    options?: {
      channels?: string[]; // default: all
      formatFrame?: (chunk: {
        channelId: string;
        streamId: string;
        body: string;
        done: boolean;
        replay: true;
        replayComplete?: true;
      }) => string; // default: chat-format
    }
  ): Array<{ channelId: string; streamId: string }>;

  // restore on hibernation wake
  restore(): Array<{ channelId: string; streamId: string; requestId: string }>;

  hasActiveStream(channelId: string): boolean;
}
```

Implementation notes:

- One row-space, namespaced by `channel_id` column. No more two
  hardcoded table names. SQL queries gain a `channel_id = ?`
  predicate.
- `formatFrame` parameterizes the wire type tag plus any other
  envelope shape the channel needs. Chat callers pass a closure
  that produces today's `CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE`
  envelope. Helper callers pass a closure that produces a
  `helper-event` envelope.
- The `chat` channel keeps the literal name `"chat"` and the
  default `tablePrefix` choice migrates the existing chat tables
  via a one-time rename or a `union all` reader for transition
  (tractable; details TBD). Acceptable to skip migration if we
  bump the framework major.
- Deletes (`clearAll`, `destroy`) take an optional channel filter.
  Default = all channels for back-compat.
- `restore()` returns _all_ active streams, not just the most
  recent — the existing implementation's "pick the most recent
  streaming row" behavior was always a code smell, defensible only
  because there could only be one.

Naming: `DurableStreamChannels` is awkward. `MultiChannelStream`?
`StreamChannels`? `ResumableStreamChannels`? Bikeshed later.
For internal back-compat, keep a thin `ResumableStream` shim that
wraps a single-channel `chat` and preserves today's API shape.

This ring is _small_ and _cheap_. Maybe a day of focused work.
Crucially, **it's the same shape regardless of what we decide for
Rings 2–6**. Whatever helper protocol we ship, the underlying
durable storage layer is multi-channel by `channel_id`. So we can
ship Ring 1 today and not regret it.

### Ring 2 — helper event vocabulary

What does a helper actually _emit_?

Two real options:

**Option A: reuse AI SDK `UIMessagePart` with a helper namespace.**

Each helper event is an existing `UIMessagePart` plus a `helperId`
discriminator. Lifecycle events become a small set of additional
parts: `helper-started`, `helper-finished`, `helper-error`. The
common message-part renderers in the React layer get most helpers
"for free."

Pros: minimal new vocabulary, immediate compatibility with anything
that already renders message parts, helpers feel like inline
mini-conversations (because they are).

Cons: not all helpers are LLM helpers — pure code task helpers
(e.g. "run this build, stream stdout") don't naturally produce
text-deltas or tool-calls. Forces those into `helper-progress`-shaped
parts.

**Option B: define a separate event vocabulary.**

Lifecycle events plus arbitrary `state` / `progress` blobs:

```ts
type HelperEvent =
  | {
      kind: "started";
      helperId: string;
      parentTurnId: string;
      type: string;
      input: unknown;
    }
  | {
      kind: "progress";
      helperId: string;
      message?: string;
      percent?: number;
      data?: unknown;
    }
  | {
      kind: "tool-call";
      helperId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool-result";
      helperId: string;
      toolCallId: string;
      output: unknown;
    }
  | { kind: "text-delta"; helperId: string; messageId: string; delta: string }
  | { kind: "finished"; helperId: string; result: unknown }
  | {
      kind: "error";
      helperId: string;
      error: { name: string; message: string; cause?: unknown };
    };
```

Pros: cleaner separation, accommodates non-LLM helpers naturally,
forces the client into an explicit demux step.

Cons: parallel vocabulary to AI SDK's UIMessagePart; renderers have
to be written or wrapped.

**Provisional answer: a hybrid.** Lifecycle events
(`started`, `finished`, `error`) plus a `parts` channel that carries
`UIMessagePart` items the helper produced. The lifecycle wrapper is
generic; the `parts` channel naturally supports both LLM and non-LLM
helpers (the latter just doesn't emit any).

### Ring 3 — parent-side API: `runHelper`

How does the parent's turn code launch a helper and get its events
plumbed into the turn?

Two real shapes, possibly both:

**Shape 1: explicit handle.**

```ts
const helper = await this.runHelper(ResearchAgent, {
  input: { query },
  parentTurnId: ctx.turnId
});

for await (const event of helper.events) {
  // events automatically also written to the durable channel for
  // this turn — for-await is a passive observer
}

const result = await helper.result;
```

The framework:

- spawns / reuses the helper sub-agent (same DO under the parent)
- starts a durable channel keyed by `(parentTurnId, helperId)`
- subscribes to the helper's event stream and writes each event
  through the channel (broadcast + persist + replay-on-reconnect)
- awaits the helper's return value as `helper.result`
- on parent turn abort, signals the helper

The for-await loop is _optional_ — if the parent only wants the
final return value, the events still flow to the browser
automatically.

**Shape 2: helper-as-AI-SDK-tool.**

```ts
tools: {
  research: helperTool(ResearchAgent),
  buildAndTest: helperTool(BuildAgent),
}
```

`helperTool(Cls)` returns an AI SDK tool whose `execute` runs the
helper end-to-end. The framework intercepts and pipes the helper's
events into the live stream while the tool is "executing." From
the LLM's perspective this is a normal tool call with an input
schema and a single output. From the user's perspective they see
rich live progress alongside the assistant message.

This is the Cursor "background agents" / Claude Code sub-agent
pattern. Almost certainly what most consumers actually want — they
let the LLM decide _when_ to dispatch helpers, just by exposing
them as tools.

We probably want **both**. Shape 2 is the high-level convenience;
Shape 1 is the escape hatch when the parent has its own logic
about when to dispatch helpers (cron-driven, condition-driven,
retry-driven).

### Ring 4 — client rendering

`useAgentChat` returns `messages: UIMessage[]`. Where do helper
events go?

**Option A: a new message part type.**

```ts
type HelperMessagePart = {
  type: "helper";
  helperId: string;
  status: "running" | "succeeded" | "failed";
  parts: UIMessagePart[]; // events the helper produced
  result?: unknown;
};
```

Attached to whichever assistant message dispatched the helper.
Composes with everything that already renders `UIMessage.parts`.
Replay falls out for free because parts are already replayable.

**Option B: parallel stream.**

`useAgentChat` returns `messages` plus `helpers: HelperState[]`,
keyed by helperId, with their own event log. The UI weaves them
back into the message stream itself.

Decoupled, but harder to reason about ordering — when in the
assistant's text did this helper start? In Option A that's
implicit in part order.

**Provisional answer: Option A.** Helper rendering becomes a
compound part renderer — given a `helper` part, render the
lifecycle plus its inner `parts` array via the same renderer
recursively. Common patterns ("collapsed by default, expand to see
detail") become CSS.

There's also a **drill-in question**: should a helper be addressable
as a separate UI surface, like Claude Code's panes?

If yes, helpers have stable sub-agent names and the standard routing
primitive Just Works for a detail view:

```tsx
const helperDetail = useAgent({
  agent: "MyAssistant",
  name: chatId,
  sub: [{ agent: "ResearchAgent", name: helperId }]
});
```

That's _free_ — we already shipped it. The inline-events view and
the detail view are the same DO viewed two different ways. Worth
preserving as an option from day one even if the inline view is
the default.

### Ring 5 — lifecycle, cancellation, persistence

The genuinely hard stuff. Each of these is a real design question:

- **Lifetime.** Per-turn (helper aborts when the turn ends) or
  persistent (helper outlives the turn, can be checked on later)?
  Different defaults make sense for different use cases. Probably:
  configurable per helper class, default per-turn.
- **Cancellation.** Three orthogonal signals:
  1. Parent turn aborted → all helpers should cancel.
  2. User cancels one helper → turn continues, that branch fails.
  3. Helper crashes / returns error → does the LLM see an error
     tool-result, or does the whole turn fail?
     Need explicit propagation. AI SDK `AbortSignal` doesn't cross DO
     RPC by default; we'd plumb cancellation via an `abortSubAgent`
     call (already shipped) keyed by helper run ID.
- **Concurrency.** N parallel helpers in one turn. Their events
  interleave on the WS. The channel ID (Ring 1) gives the client
  enough info to demux; the message-part wrapper (Ring 4 Option A)
  groups them by which assistant message dispatched them.
- **Retention.** Finished helpers' event logs need cleanup. Tied
  to turn retention? Independent? Probably: helper retention follows
  the parent turn's retention. Helpers running when the parent turn
  is deleted get aborted.
- **Auth / quota.** Helpers inherit the parent's auth context.
  Helper LLM tokens count against the parent user's quota. Both
  need to be wired explicitly — the routing primitive doesn't carry
  request-scoped state across `subAgent()` calls today.
- **Backpressure.** A chatty helper firing many events per second
  vs. our existing chunk batching. `ResumableStream` already has
  `CHUNK_BUFFER_SIZE` / `CHUNK_BUFFER_MAX_SIZE`; per-channel batching
  is a Ring 1 detail but worth confirming the helper protocol
  doesn't generate event volumes the existing batching can't keep up
  with.

### Ring 6 — Think specifics

Think has fibers / sessions / turns as first-class concepts that
AIChatAgent doesn't:

- A helper run could naturally be a **child fiber** of the parent
  turn's fiber, with cancellation following the fiber tree.
- Helper state could persist in a Think **session** scoped to
  the helper, with the durable channel being the session's
  externally visible event log.
- The `beforeStep` hook (#1394) is a natural place to inject helper
  lifecycle decisions ("if step 0, force the planner-helper before
  the LLM gets to choose").

AIChatAgent has none of these. Doing helpers right in AIChatAgent
would require either growing AIChatAgent toward Think, or limiting
helper support to Think-only.

**Provisional answer:** design Think-first, with the durable
multi-channel primitive (Ring 1) being framework-wide. AIChatAgent
inherits Ring 1 (existing usage just becomes the `chat` channel)
but doesn't grow helper support until there's reason to.

## Open questions

Concrete ones the design has to answer before it can ship:

1. **What's the public name for "sense (2) sub-agents"?** "Helpers"?
   "Tasks"? "Workers"? "Sub-tasks"? Avoid colliding with the existing
   "sub-agent" routing terminology. (Internal note: we've been calling
   them helpers in this doc, which is fine, but the public name
   matters for docs and API ergonomics.)
2. **Helper-as-tool vs. helper-as-RPC: ship both, or pick one for v1?**
   Shape 2 (tool wrapper) is the ergonomic story; Shape 1 (explicit
   handle) is the escape hatch. Picking only Shape 2 forces every
   non-LLM-driven helper through the LLM's tool-decision loop, which
   isn't always what you want.
3. **AI SDK part reuse vs. separate vocabulary.** Hybrid is the
   provisional answer; needs validation against a real consumer.
4. **Per-turn vs. persistent helpers as the default lifetime.** Per-turn
   matches the most common pattern (research summarizer, code
   reviewer). Persistent matches the "background build is running"
   pattern. Both are real.
5. **Cancellation semantics on partial failure.** When one of three
   parallel helpers errors, does the LLM see an error tool-result and
   continue, or does the whole turn fail?
6. **Helpers across hibernation.** Parent DO hibernates while three
   helpers are running. On wake, the durable channel restores the
   event logs (Ring 1 handles this). But are the helpers themselves
   still running? Sub-agents are colocated facets — they presumably
   wake too. Need to confirm and add a smoke test.
7. **Retention boundary.** Helper event log lives for as long as the
   parent turn lives, then GCs. Helper sub-agent storage lives for
   as long as the helper sub-agent lives, which might be longer.
   These two retention windows aren't the same and probably shouldn't
   be conflated.
8. **Migration of the existing `cf_ai_chat_stream_*` tables.** If
   Ring 1 changes the table layout, existing AIChatAgent / Think
   deployments need a migration story. Options: rename the chat
   channel's tables in-place during constructor; teach the multi-channel
   reader to also read the legacy tables transparently; defer migration
   to a major bump. Pick before shipping Ring 1.
9. **Wrangler config implications.** Each helper class has to be a
   bound `new_sqlite_classes` entry per the routing primitive's
   requirements. How invasive is this for users who just want
   "spawn a helper"? Possibly a ergonomics issue worth solving with
   a single `helpers: [HelperA, HelperB, ...]` declaration on the
   parent class.
10. **Test infrastructure.** `examples/assistant` finally got a
    vitest+workers harness in #1384's follow-ups. Helper streaming
    needs equivalent coverage: parent broadcasts a helper event,
    client receives it, mid-helper refresh replays cleanly. The
    harness pattern from `assistant/src/tests/` is the reference.

## Recommended staged plan

Don't ship just the OP's ctor args. Don't try to design and ship
the whole helper system in one PR. Stage it.

### Stage 1: minimal framework change for `messageType`

Per the 2026-04-27 design pivot above, this is much smaller than
the original "ship Ring 1 properly" plan. Just one ctor option on
`ResumableStream`:

```ts
export class ResumableStream {
  constructor(sql: SqlTaggedTemplate, options?: { messageType?: string });
}
```

`messageType` defaults to `CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE` so
existing chat callers (`AIChatAgent.ts`, `think.ts`, the 1463-line
`resumable-streaming.test.ts` regression suite) compile and behave
byte-identically. Helper sub-agents construct
`new ResumableStream(this.sql.bind(this), { messageType: "helper-event" })`
and their replay frames go out with the right wire tag.

The `tablePrefix` part of the OP's original proposal is _not_
needed: each helper has its own DO and therefore its own SQLite —
table-level collisions are impossible by isolation, not prefix.

Concrete checklist:

- [ ] add `messageType` ctor option, replace four hardcoded
      `CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE` references in
      `replayChunks` with `this._messageType`
- [ ] verify existing `resumable-streaming.test.ts` (1463 lines)
      passes unchanged
- [ ] CHANGESET (`agents` patch — additive, fully back-compat)
- [ ] (Optional) close #1377 referencing this commit

This is roughly a 10-LOC change. The bulk of the work for "agents
as tools" is in Stage 2, not Stage 1. The framework only needs to
get out of the way.

**What's _not_ in Stage 1 anymore** (parked, not killed):

- multi-channel `ResumableStream` schema redesign
- table prefix parameterization
- migration of `cf_ai_chat_stream_*`
- per-channel state machines

If a future use case genuinely needs one DO to multiplex N
independent durable streams (workflow with parallel tracks; a DO
that broadcasts both a chat and a separate data feed; etc.), the
multi-channel design earlier in this doc is the shape to revive.
For helpers, single-channel-per-DO + parent forwarding is the
better fit and what Stage 2 builds on.

### Stage 2: prototype helper streaming in `examples/agents-as-tools`

Build a new focused example, **`examples/agents-as-tools`**, that
exists specifically to flesh out this story as the design firms up.
Think-based, kept deliberately small and crisp — same role
`examples/multi-ai-chat` plays for the routing primitive.

Why a new focused example, not a tab inside `examples/ai-chat` or
`examples/assistant`:

- `examples/ai-chat` is the AIChatAgent reference and is built on a
  framework that doesn't have Think's fibers / sessions / turns
  (Ring 6). Helpers want to be Think-first; AIChatAgent helpers are
  a downstream port at best. Forcing the helper story into `ai-chat`
  either pessimizes the API to fit the lower-capability substrate or
  shows code in an example whose runtime can't natively support it.
- `examples/assistant` is already the kitchen-sink stress test. It
  earned that role by accumulating real features (multi-session,
  shared workspace, shared MCP, OAuth, MCP). Bolting an actively-
  evolving design onto it makes every churny iteration risk
  regressing the rest. We can fold helpers into `assistant` _later_,
  after the API stabilizes — same trajectory routing took
  (`multi-ai-chat` proved it, `assistant` integrated it).
- A focused example is the unit of fast iteration. Keeping it small
  is the point.

Why the name `examples/agents-as-tools`:

- It's the well-known, Googleable phrase for the pattern (Swarm,
  AI SDK, "tool that's another agent"). Users searching for this
  will type those words.
- It captures the most likely shipped headline API — `helperTool(Cls)`
  wrapping a sub-agent into an AI SDK tool, which is Ring 3 Shape 2.
- It pairs cleanly with the existing examples taxonomy:
  - `examples/multi-ai-chat` — minimal proof of sub-agent **routing**
    (sense 1, sibling chats)
  - `examples/agents-as-tools` — minimal proof of sub-agents **as
    turn-scoped helpers** (sense 2, inline events)
  - `examples/assistant` — kitchen-sink that combines both
- Crucially, the name doesn't lock us into a public name for "sense
  (2) sub-agents" — that's still an open question (#1 in the list
  above). "Agents-as-tools" describes the _pattern_, not the
  framework primitive's name. If we later decide the public name is
  "helpers," "tasks," or "workers," the example name still makes
  sense — those are all instances of agents-as-tools.

Concrete first helper to build:

- **Research summarizer.** Takes a query, fans out to a few search
  tools, returns a synthesis. Per-turn lifetime. Pure LLM helper.
  Fits AI SDK part vocabulary cleanly.

Other helpers to add as the example grows, validating the harder
parts of the design:

- **Workspace planner.** Takes a multi-file edit task, plans changes,
  emits per-file progress, applies via the existing `state.*` API.
  Per-turn lifetime. Mix of LLM and pure-code phases. Tests the
  hybrid event vocabulary (Ring 2).
- **Build runner.** Kicks off a long-running build, streams stdout,
  reports exit code. Persistent (outlives the turn). Tests the
  `lifetime: "persistent"` path (Ring 5).
- **Parallel research fan-out.** Three queries dispatched at once,
  events interleaved on the WS, demuxed in the UI by `helperId`.
  Tests Ring 4's grouping / Ring 5's concurrency story.

The point of the prototype is to **answer the open questions
empirically** before freezing them in an RFC. The four post-#1384 PRs
(#1393–#1396) are the recent template for "let an example exercise
the pattern, then promote what works."

This stage _can_ modify library APIs (unlike a pure usage example) —
it's where the helper protocol APIs are first drafted. But every
modification should be cheap to revisit, because the whole point is
discovery. Hand-rolled helpers in the example's `server.ts` that we
know we'll throw away are fine.

Stub structure, mirroring `examples/multi-ai-chat`:

```
examples/agents-as-tools/
├── README.md
├── package.json
├── wrangler.jsonc
├── env.d.ts
├── index.html
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── index.tsx
    ├── server.ts        # Parent agent + helper class(es)
    ├── client.tsx       # Chat UI with inline helper rendering
    └── styles.css
```

The `examples/ai-chat` README gets one line added when this lands:
"For delegating work to helper agents during a turn, see
`examples/agents-as-tools`." Discovery cost stays low.

### Stage 3: write the RFC

Once Stage 2 has produced one or two prototype helpers, write
`design/rfc-inline-sub-agent-events.md` (or whatever the public name
ends up being). Format follows `design/rfc-think-multi-session.md`
and `design/rfc-ai-chat-maintenance.md`:

- Problem statement (this doc, condensed)
- Goals / non-goals
- The picked answers to the open questions, with rationale
- Public API surface
- Migration / compatibility
- Alternatives considered
- Open questions still deferred

The RFC is _not_ this doc. This doc is the brain dump that informs
it; the RFC commits to specific shapes.

### Stage 4: implement the helper protocol in the framework

Land in stages, each its own PR. Per the 2026-04-27 pivot, the
shape of these PRs is simpler than the original plan because
helpers are sub-agents and the streaming primitive stays single-
channel:

1. Helper event vocabulary types in `agents/chat` (or a new
   `agents/helpers` subpath).
2. **Tiny `EventStreamingAgent` recipe / mixin / base class** —
   just enough to make "helper Agent that exposes a
   `ReadableStream` of events over RPC and durably stores them in
   its own `ResumableStream`" cheap to write. Could be a 50-LOC
   base class or a documented pattern; defer naming until we have
   two consumers.
3. **Parent-side `runHelper(Cls, args)`** that wraps the
   `subAgent` + `startAndStream` + active-helpers-tracking +
   forward-broadcast pattern. Returns the helper's final result.
4. `helperTool(Cls)` AI SDK tool wrapper — sugar over `runHelper`
   that exposes a helper as a tool the LLM can call directly.
5. Client-side `UIMessagePart` extension and renderer in
   `useAgentChat`. Probably lands as part of, or right after, the
   PR 3 hoist of `useAgentChat` into `agents/react` (see
   `wip/think-multi-session-assistant-plan.md`).
6. Cancellation propagation through `abortSubAgent`.
7. Lifetime / retention / quota plumbing — including the
   "subscribe to live tail" capability that lets a parent
   re-establish a forwarding loop after its own crash (separate
   from per-turn helpers, where the run is allowed to be
   interrupted).
8. Documentation in `docs/`. Decide whether `docs/sub-agents.md`
   gains a "helpers" section or whether they get their own doc.

Each PR is independently shippable. Each PR adds a concrete
capability to `examples/agents-as-tools`. Once the API stabilizes,
fold the most ergonomic shape (probably `helperTool(Cls)` as one more
tool kind) into `examples/assistant` and add a tiny one-tool demo to
`examples/ai-chat` so the chat-features taxonomy stays complete.

### Stage 5: decide what to promote (if anything) further

Same shape as PR 4 in `wip/think-multi-session-assistant-plan.md`:
once the API has lived in `examples/agents-as-tools` for a release or
two, decide whether specific helper classes (research summarizer,
workspace planner, build runner) should ship as library primitives,
whether the helper protocol gets its own top-level package, and
whether `examples/agents-as-tools` graduates from "focused minimal
proof" into a maintained reference example. Defer until Stage 4 is
settled.

## What this plan is optimizing for

Same instincts as the multi-session plan:

- **Unblock the OP cheaply now**, on a fix we don't regret.
- **Don't freeze the design** on one team's prototype.
- **Use a focused, throwaway-friendly example** (`examples/agents-as-tools`)
  to exercise the design before promoting any abstraction into the
  library. Avoid bolting an evolving design onto the kitchen-sink
  (`examples/assistant`) or the AIChatAgent reference
  (`examples/ai-chat`) — fold those in later, once the API has
  settled.
- **Land each piece independently** so feedback can come in
  between stages, not after.
- **Keep the primitive (Ring 1) in `agents/chat`** with the rest of
  the chat-shared layer the post-#1384 PRs have been growing.
- **Stay Think-first for the helper protocol** but framework-wide
  for the streaming primitive.

What this plan is _not_ trying to optimize for: comprehensive
helper support in v1. Most of the questions in Ring 5 ("backpressure,"
"per-turn vs persistent," "auth context propagation") are real but
not blocking for a usable v1. They become refinement passes after the
shape is locked.

## Cross-references

- Issue: [`cloudflare/agents#1377`](https://github.com/cloudflare/agents/issues/1377)
- Existing module: `packages/agents/src/chat/resumable-stream.ts`
- Routing primitive doc: `docs/sub-agents.md`
- Shipped multi-session plan: `wip/think-multi-session-assistant-plan.md`
- Chat-shared-layer extraction: `design/chat-shared-layer.md`
- Think roadmap (where helper support could land): `design/think-roadmap.md`
- Recent adjacent PRs:
  [#1374](https://github.com/cloudflare/agents/pull/1374),
  [#1384](https://github.com/cloudflare/agents/pull/1384),
  [#1393](https://github.com/cloudflare/agents/pull/1393),
  [#1394](https://github.com/cloudflare/agents/pull/1394),
  [#1395](https://github.com/cloudflare/agents/pull/1395),
  [#1396](https://github.com/cloudflare/agents/pull/1396)
- Related issues filed from this prototype:
  [`cloudflare/partykit#390`](https://github.com/cloudflare/partykit/issues/390)
  (fresh partyserver 0.5.x DOs + old compat dates lose `this.name` on
  alarm wake),
  [`cloudflare/workerd#6675`](https://github.com/cloudflare/workerd/issues/6675)
  (DO RPC object streams fail with opaque "Network connection lost"),
  and
  [`cloudflare/agents#1399`](https://github.com/cloudflare/agents/issues/1399)
  (discussion: should `subAgent` / `parentAgent` return `Rpc.Stub<T>`-
  narrowed types instead of `InstanceType<T>`?)

## Status

- This doc: written, design pivoted 2026-04-27 (see "Design pivot"
  section above), not formally reviewed.
- Stage 1 (`messageType` ctor option on `ResumableStream`): **landed.**
  ~10 LOC change in `packages/agents/src/chat/resumable-stream.ts`,
  `ResumableStreamOptions` type added to `agents/chat` exports,
  changeset added at `.changeset/resumable-stream-message-type.md`.
  All 28 existing `resumable-streaming.test.ts` regression tests
  pass byte-identical (defaults preserve existing chat-channel
  behavior).
- Stage 2 (`examples/agents-as-tools` prototype): **v0.1 landed**
  (helpers-as-sub-agents pattern). Concretely:
  - `Researcher` owns its own `ResumableStream` configured with
    `messageType: "helper-event"`. Events are durably stored on the
    helper's own DO before they leave its isolate.
  - `Researcher.startAndStream(query, helperId)` returns a
    `ReadableStream<Uint8Array>` over DO RPC. Each chunk is one or
    more NDJSON frames (`{ sequence, body }`). This byte-stream shape
    is intentional: workerd's DO RPC stream bridge transports
    `Uint8Array` chunks, while object chunks fail at runtime with the
    opaque "Network connection lost" error tracked in
    `cloudflare/workerd#6675`. Each emitted event is stored + flushed
    before being written to the stream so reconnect replay catches up
    cleanly. The stream body is wrapped in `keepAliveWhile`, aligning
    helper live execution with Think's main-turn keepalive pattern.
  - `Assistant.runResearchHelper` decodes the byte stream, splits on
    newlines, broadcasts each event with the matching `sequence` for
    client-side dedup, and marks the helper run completed/error. It
    intentionally does **not** delete the helper in `finally`: the
    helper DO owns the durable event log, so retaining it is what lets
    completed helper timelines replay after refresh. Tracks helper
    runs in `cf_agent_helper_runs`. Helper-side errors are emitted as
    inline helper events and then surfaced as real tool failures rather
    than successful empty summaries.
  - `Assistant.onConnect` runs after Think's chat-protocol setup,
    walks `cf_agent_helper_runs`, fetches each helper's stored events
    via `getStoredEventsForRun` and replays them as `replay: true`
    frames (with the same `sequence` they had when first emitted).
    If a row was marked `interrupted` after parent wake, replay appends
    a synthetic terminal error event so the UI does not show a
    permanently-running panel.
  - The client now dedupes by `(parentToolCallId, sequence)` and
    sorted-inserts events to handle the small reconnect-window race
    where one event can arrive both as a replay frame and as a live
    broadcast, and to preserve helper-emit order even when replay and
    live frames arrive out of order.
  - The wire format gained one field (`sequence: number`); rendering
    is unchanged.

  UX/DX polish after the first working run: the composer is a regular
  single-line `Input` that submits on Enter, the header has a Clear
  button wired to `clearHistory()`, helper-event state is reset on
  local and cross-tab clears, and assistant/user text plus reasoning
  parts render through Streamdown with the standard Kumo theme bridge.
  The example's `wrangler.jsonc` also moved to `compatibility_date:
2026-04-15` so partyserver 0.5.x can rely on `ctx.id.name` in alarm
  handlers (see `cloudflare/partykit#390` for the upstream issue).

  **Refresh-during-helper and refresh-after-helper-completion now work
  correctly** — both the chat stream and helper timeline catch up.
  Completed/error helper DOs are retained until Clear/future GC so the
  timeline remains available after the assistant turn finishes. Parent
  wake with rows still marked `running` converts them to `interrupted`
  and replays whatever the helper stored before the parent died.

  Specific portability hooks for the eventual AIChatAgent port: the
  `Researcher` class extends `Agent` (not `Think`), the helper-event
  protocol doesn't reference Think types, the parent forwarding code
  uses `this.broadcast(...)` (works on both AIChatAgent and Think),
  and `getTools()` returns plain AI SDK tools. The Think-only piece
  is the parent class itself; porting it to AIChatAgent is roughly a
  30-line `onChatMessage` override.

### Coverage gap vs. issue #1377's actual workload (2026-04-28)

GLips's followup
([comment 4328296343](https://github.com/cloudflare/agents/issues/1377#issuecomment-4328296343))
included two screenshots of the workload he is shipping: an
orchestrator chat that dispatches `mcp_analytics_investigate`, which
fans out to several `code_mode_execute` subagents, each running their
own multi-turn loop with thinking blocks interleaved between tool
calls. Mapping that against v0.1:

|                                                       | Status               | Where                                                                                        |
| ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| Live event delivery during a turn                     | done                 | parent `broadcast()` of forwarded helper events                                              |
| Mid-run disconnect + reconnect                        | done                 | helper `ResumableStream` + parent `onConnect` replay; `reconnect-replay.test.ts`             |
| Mid-run page refresh                                  | done                 | same code path                                                                               |
| Post-run page refresh                                 | done                 | helper facet retained; `cf_agent_helper_runs` row + replay                                   |
| Subagent rendered as a tool call in the parent chat   | done                 | `research` tool output is the helper summary; events render inline under the tool call       |
| `messageType` ctor option on `ResumableStream`        | done                 | `acce611c`                                                                                   |
| `tablePrefix` ctor option on `ResumableStream`        | not shipping         | the pivot replaces it — see "Decisions confirmed 2026-04-28" below                           |
| Multi-turn helpers (own inference loop, tools, think) | done (2026-04-28)    | `Researcher` extends `Think`; chunks forwarded through `helper-event` envelope               |
| Parallel helper fan-out                               | done (2026-04-28)    | `compare` tool fans out via `Promise.all`; client demuxes per `(parentToolCallId, helperId)` |
| Per-helper drill-in detail view                       | **not done; free**   | `Researcher` is itself a Think, so `useAgentChat` against `useAgent({ sub: [...] })` works   |
| `helperTool(Cls)` framework helper                    | **deferred**         | Stage 4; today the parent rolls its own spawn/forward loop                                   |
| AIChatAgent port                                      | deferred             | Stage 5                                                                                      |

The reconnect/refresh story is closed. The remaining work is
demonstrating the pattern at the depth GLips's actual workload runs
at: multi-turn helpers, multiple in flight at once, and a way to
drill in to one of them.

### Decisions confirmed 2026-04-28

1. **Helpers must run their own inference loop.** v0.1's `Researcher`
   scripts a deterministic step/tool-call sequence and makes one
   synthesize call. That's enough to validate the byte-stream
   contract and the replay machinery, but it doesn't exercise the
   actual workload — multi-turn agents that call multiple tools and
   reason between them. The next helper class extends Think (the same
   Think the parent uses) and runs its own inference loop, with each
   internal turn's events forwarded through the same `helper-event`
   envelope. AIChatAgent gets the equivalent treatment in a later
   stage; the protocol is already chat-framework-agnostic so the port
   is mechanical.
2. **Parallel helper fan-out is in scope, orchestrator-driven.** The
   parent LLM decides when and how to fan out — multiple `research`
   calls in one turn, or a second tool that itself dispatches a batch
   of helpers. The wire protocol is designed for this
   (`parentToolCallId + sequence` demuxes per-helper streams) but it
   has not been driven under load, and the UI hasn't been
   pressure-tested with concurrent panels.
3. **Do not ship `tablePrefix`.** The 2026-04-27 pivot is the answer
   to the same-DO collision GLips originally hit: helpers run on
   their own DOs and therefore have their own SQLite, so two
   `ResumableStream` instances cannot collide on tables by
   construction. The cost (~10 LOC and a small reconnect-replay
   step) is much smaller than maintaining a multi-channel schema on
   the parent. The issue reply will explain this rather than landing
   the literal patch.
4. **Per-helper drill-in detail view is in scope.** The routing
   primitive already supports it (`useAgent({ sub: [...] })` against
   the helper's name). v0.1 calls this out as "free" but doesn't
   wire it up. The example will grow a per-helper detail panel so
   the affordance is demonstrated, not just claimed.
5. **First-class framework integration (`helperTool(Cls)`,
   `EventStreamingAgent`) is deferred.** Today's hand-rolled
   `runResearchHelper` is the proto-shape of `helperTool(Cls)`;
   collapsing it into a framework helper is correct but premature
   while the protocol is still being validated against multi-turn
   and parallel cases. Promote after those land.

### Hibernation / fibers gaps after v0.1

The current prototype has a coherent reconnect story, but it is not
yet the same durability story as Think's main chat turns.

What works now:

- **Active-helper reconnect.** While the parent is alive and a helper
  is running, the parent tracks the run in `cf_agent_helper_runs`.
  Reconnecting clients replay the helper's stored events from the
  helper DO, then continue receiving live forwarded events.
- **Completed-helper reconnect.** Completed/error helper DOs are
  retained, so reconnect after the assistant turn finishes can still
  replay the helper timeline.
- **Parent wake after interrupted helper.** On parent `onStart`,
  `running` helper rows become `interrupted`. Reconnect replays the
  events stored before the parent died and appends a synthetic terminal
  error event so the UI does not show a permanently-running panel.

What is still missing:

- **Helper-side `keepAliveWhile`: shape in place.** The main Think chat
  turn is wrapped in `keepAliveWhile`; helper execution now is too.
  Today `keepAlive()` is a soft no-op on facets because workerd does
  not support independent facet alarms yet, so the live run still
  relies on the active RPC stream / Promise chain for liveness. Keeping
  the wrapper documents the intended Agents-level lifecycle and should
  become meaningful once alarms work inside facets.
- **Helper fibers.** Main chat turns can run inside a chat-recovery
  fiber. Helper work currently does not. A helper run could become a
  child fiber of the parent turn, but that requires a design for
  naming, result propagation, and cancellation.
- **Live-tail reattachment.** After a parent crash, there is no way for
  a newly-woken parent to reattach to an already-running helper's live
  event tail or recover the helper's eventual result. Today we mark the
  run `interrupted` instead. True persistent helpers need a
  subscribe-to-existing-tail capability plus a result/terminal-state
  handoff back to the parent.
- **Retention / GC.** Completed helpers are retained until Clear.
  Production shape needs age/count/message-retention GC, likely tied to
  chat message retention and branch deletion.
- **Hibernation test matrix.** Most of this landed with the Stage 2
  test harness — `reconnect-replay.test.ts` covers active-helper
  reconnect, completed-helper replay, parent restart →
  `interrupted` terminal event (synthetic, with and without stored
  events), and the multi-run interleave; `clear-helper-runs.test.ts`
  covers Clear deleting retained helper facets. Still missing: a
  helper DO hibernation cycle (helper evicted between completion
  and parent reconnect) and a true parent-eviction-mid-helper test
  (today the suite simulates this via `testRerunOnStart` instead of
  driving a real eviction).

- Stage 2 (`examples/agents-as-tools` test harness): **landed.**
  Originally 25 tests; now 29 after the Option B refactor and review
  fixes. Four files (`registry`, `clear-helper-runs`, `helper-stream`,
  `reconnect-replay`) modeled on `examples/assistant/src/tests`. Test
  worker subclasses production `Assistant` and `Researcher`;
  `TestResearcher` overrides `getModel()` with a deterministic mock
  LanguageModel V3 so the helper's Think inference loop runs
  end-to-end without a Workers AI binding. The mock has an `ok` /
  `throws` mode so the B2 error-surfacing path can be exercised
  inside the harness too.
- Stage 2 (multi-turn Think helper, "Option B" from the design pivot
  discussion): **landed 2026-04-28.** Concretely:
  - `Researcher` now `extends Think<Env>` with its own `getModel`,
    `getSystemPrompt`, `getTools` (one simulated `web_search`).
    Helper runs are a real Think turn driven by `saveMessages`, and
    the helper's chat stream is the canonical durable event log via
    Think's own `_resumableStream`. There is **no second
    `ResumableStream`** on the helper — the same-DO collision the
    original #1377 was about cannot occur.
  - The helper-event vocabulary collapsed from six kinds
    (`started` / `step` / `tool-call` / `tool-result` / `finished` /
    `error`) to four (`started` / `chunk` / `finished` / `error`).
    Lifecycle (`started` / `finished` / `error`) is synthesized by
    the parent from `cf_agent_helper_runs` row data so panels render
    even before any chunks arrive and replay correctly without a
    stored terminal chunk; `chunk` carries an opaque JSON-encoded
    `UIMessageChunk` body forwarded verbatim from the helper's
    `_streamResult`.
  - `Researcher` overrides `broadcast` to tee `MSG_CHAT_RESPONSE`
    chunks into the active RPC stream while a `runTurnAndStream` is
    in flight. Other broadcasts (state, identity, MSG_CHAT_MESSAGES,
    direct WS clients of the helper) pass through untouched, so
    drill-in via `useAgent({ sub: [...] })` still produces a working
    chat against the helper.
  - `cf_agent_helper_runs` schema gained four columns:
    `helper_type`, `query`, `summary`, `error_message`. All four
    feed the parent's synthesized lifecycle events on `onConnect`
    replay; no helper RPC is needed to reconstruct the panel.
  - `Researcher` exposes `getChatChunksForReplay` (reads Think's own
    stored chunks via `_resumableStream.getStreamChunks`) and
    `getFinalTurnText` (returns the assistant message persisted by
    THIS turn, identified by diffing message ids against a snapshot
    captured at turn start) for the parent's reconnect-replay and
    tool-output paths.
  - The client uses `applyChunkToParts` from `agents/chat` to
    accumulate the helper's `UIMessage.parts` from the forwarded
    chunk firehose — the same primitive `useAgentChat` uses for the
    assistant's main message. Inline rendering shows text, reasoning
    blocks, and internal tool calls, exactly the way GLips's
    screenshots in #1377-comment-4328296343 show them.
  - Tests rewritten end-to-end. `TestResearcher` overrides
    `getModel()` with a deterministic mock LanguageModel V3 so a
    real Think turn can run inside the harness with no AI binding.
    Reconnect-replay tests seed pre-built `UIMessageChunk` bodies
    via `testWriteChunks(chunks, status)`, which writes through
    Think's own `_resumableStream` exactly the way production does.
  - The client renders helper events as a mini-chat panel (text +
    reasoning + tool calls) instead of the previous timeline of
    typed lifecycle lines. The shape mirrors how `useAgentChat`
    renders the assistant's message because it IS the same chunk
    vocabulary.
- Stage 2 (Option B review fixes): **landed 2026-04-28** as a
  follow-up commit to the Option B refactor. Eight of nine review
  findings addressed; B3 (schema migration for existing v0.1 DOs)
  deferred — still a prototype, wipe `.wrangler/state` after pulling
  for a clean run.
  - **B1 + B2 — actual error message surfaced to the user.** Think's
    `_streamResult` catches inference errors internally and broadcasts
    them as `error: true` chat-response frames whose `body` is the
    error string (not a `UIMessageChunk`). v0.2 originally forwarded
    those bodies into the chunk pipeline, where `applyChunkToParts`
    silently dropped them on the client; the user only saw the
    generic "Researcher finished without producing assistant text"
    fallback. Fix: `Researcher.broadcast` detects `error: true`
    frames and stashes the body in `_lastStreamError`; the parent's
    `runResearchHelper` reads `helper.getLastStreamError()` when no
    summary is produced and surfaces the actual error.
  - **B4 — parent abort propagates to helper inference.** Captured
    `requestId` from `saveMessages`'s return into `_activeRequestId`;
    the ReadableStream's `cancel` callback now calls
    `abortCurrentTurn`, which dispatches into Think's `_aborts`
    registry to actually cancel the in-flight inference loop. No
    more burning Workers AI on output the parent already abandoned.
    Required reaching into Think's `_aborts` via bracket access —
    promoting that to a public `Think.abortRequest(id)` is the right
    framework follow-up.
  - **H1 — final-turn text resolved by snapshot/diff.** Replaced
    `getFinalAssistantText` (walked backwards through `messages`)
    with `getFinalTurnText`, which captures the set of pre-turn
    assistant ids in `_preTurnAssistantIds` before `saveMessages`
    runs and returns the first NEW assistant message after.
    Robust against drill-in clients appending their own turns
    before the parent reads the summary; v0.2's previous behavior
    would have fed a drill-in user's text back to the orchestrator
    as the helper's research result.
  - **H2 — concurrent-call guard.** `_runInProgress` boolean set
    sync at entry of `runTurnAndStream`, cleared in `finally` /
    `cancel` via a `releaseClaim` closure. Throws on the second
    concurrent call before either's `start` callback fires (an
    `_activeForwarder !== undefined` check would race because
    `start` is invoked lazily on first read). The guard is verified
    by code review rather than test — both available test paths
    tripped over a workerd JSRPC quirk that doesn't affect
    correctness but lights up vitest's unhandled-error detector;
    documented inline alongside where the test would have lived.
  - **H4 — `chatRecovery = false` on `Researcher`.** Helpers are
    per-turn workers driven over RPC; Think's default-on
    chat-recovery fiber would silently re-run the inference loop
    into a parent that's already marked the run `interrupted` on
    every helper hibernate-and-wake cycle. One-line override.
  - **S1 — dropped redundant `keepAliveWhile` wrap.** `saveMessages`
    already wraps its body; the outer wrap was a leftover.
  - **S2 — orphan stream cleanup.** `getChatChunksForReplay` detects
    a `streaming` metadata row whose live LLM reader is gone
    (orphaned by hibernation) and finalizes it before returning the
    chunks. Prevents per-helper `streaming`-row leaks that would
    otherwise wait for `_maybeCleanupOldStreams`'s 24-hour GC.
  - **B3 — schema migration: not addressed.** `cf_agent_helper_runs`
    gained four columns in the Option B refactor; `create table if
    not exists` doesn't ALTER. Existing v0.1 deployments would fail
    on INSERT. Documented as "wipe `.wrangler/state`" for now,
    promote to a real migration if the example graduates beyond
    prototype.
  - Two new tests added (29 total): `B2` end-to-end (drives the mock
    in `throws` mode and asserts the parent surfaces the actual
    error); `H1` (`getFinalTurnText` returns null on a never-ran
    helper, returns this turn's text after a successful run).
  - Other review items left as-is: **H3** (`_lastClientTools` /
    `_lastBody` leak across drill-in vs parent-driven turns —
    benign with no client tools defined, document if drill-in lands)
    and **H5** (`clearHelperRuns` mid-active-run race — best-effort
    cleanup, transient flicker, not worth complicating the callable).
- Stage 2 (parallel helper fan-out): **landed 2026-04-28.** Both
  fan-out shapes are wired and tested:
  - **Alpha** (LLM-driven): the LLM calls `research` multiple times
    in one turn (AI SDK `parallel_tool_calls` default). Each helper
    runs in its own facet under its own `parentToolCallId` and
    renders as one panel under one chat tool part.
  - **Beta** (programmer-driven): a new `compare(a, b)` tool's
    `execute` dispatches both helpers via `Promise.all`. Both share
    the chat tool call's `parentToolCallId`; the wire format
    distinguishes them by `event.helperId`. Renders as two sibling
    panels under one chat tool part — the visible "fan-out from one
    tool call" pattern from #1377-comment-4328296343 image 3.
  - Client refactor to support Beta:
    `helperStateByToolCall: Record<parentToolCallId, Record<helperId,
    HelperState>>`; dedup key extended from `(parentToolCallId,
    sequence)` to `(parentToolCallId, helperId, sequence)` because
    two parallel helpers under one tool call both legitimately emit
    a `sequence: 0` started event. `<MessageParts>` renders an array
    of `<HelperPanel>`s per tool part rather than a single panel.
  - Three new tests in `parallel-fanout.test.ts`: Alpha live
    broadcast (different parentToolCallIds), Beta live broadcast
    (same parentToolCallId, distinct helperIds), and Beta replay
    (`onConnect` walks two seeded rows sharing parentToolCallId
    and emits per-helper frames without sequence collisions). 32
    tests total now.
  - One new test helper: `startCollectingHelperEvents(ws)` — a
    persistent message accumulator that subscribes at call time and
    keeps a list of frames as they arrive. Needed because the
    existing `collectHelperEvents` lazily attaches a fresh
    `once`-listener per next-message and would miss broadcasts that
    happen synchronously inside an awaited `Promise.all` before any
    test-side await fires.
- Stage 2 (parallel fan-out polish pass): **landed 2026-04-28**
  follow-up to the initial fan-out commit. Five review findings
  addressed:
  - **B1: `compare` uses `Promise.allSettled` and returns a
    structured outcome** instead of `Promise.all` and throwing.
    Previously, a partial failure (one helper errored, the other
    succeeded) flipped the whole tool call to `error` while the
    surviving helper's panel still showed "Done" — a mixed signal.
    The new shape is `{ a: { query, summary | error }, b: { query,
    summary | error } }`; the orchestrator LLM can react to "one of
    two succeeded" honestly. Killing the surviving helper on first
    failure is left for a future B4-style abort propagation pass
    (one parent-side abort signal would need to plumb into both
    helpers' `_aborts.cancel`).
  - **B2: deterministic panel ordering.** `started` event now
    carries an `order: number` field; the parent stamps it from a
    `displayOrder` parameter on `runResearchHelper` (defaults to 0
    for the single-helper `research` tool; `compare` passes 0/1).
    The client sorts each tool-call's helper bucket by `order`, so
    panels appear left-to-right matching the LLM's input position
    rather than the random arrival order of `started` broadcasts.
    Persisted in `cf_agent_helper_runs.display_order` so `onConnect`
    replay synthesizes the same ordering. Schema bump applied via an
    idempotent `try { ALTER TABLE … ADD COLUMN } catch {}` in
    `onStart`, which doubles as a real (if minimal) migration path
    for existing v0.1 deployments — the only column the v0.1 → v0.2
    transition added that wasn't covered by `CREATE TABLE IF NOT
    EXISTS`. (B3 from the earlier review remains otherwise
    deferred.)
  - **N3: bulletproof dedup key.** Client's seen-sequence map is
    now keyed by `JSON.stringify([parentToolCallId, helperId])`
    rather than a `${parent}::${helper}` template. Removes the
    theoretical collision when either id contains `::` (no real-
    world ids do, but the array form is collision-proof for free).
  - **C1: three-helper Beta test.** Added a 3-helper fan-out test
    that stresses the broadcast path under N>2 — three concurrent
    `runResearchHelper` calls under one parentToolCallId, each with
    its own `displayOrder`. All three rows complete; live frames
    demux per-helper with monotonic sequences each starting at 0.
  - **C2: replay-order assertion.** Existing replay test now also
    asserts (a) `started` events on replay carry the row's
    `display_order` as `order`, and (b) `onConnect` replay does NOT
    interleave per-helper frames — helper-x's last frame arrives
    before helper-y's first. Pins down the per-row serialization
    `onConnect` does today against a future "interleave for
    fairness" refactor.
- Stage 3 (RFC): not started. Blocks on Stage 2 producing at least
  one or two prototype helpers exercising the multi-turn and parallel
  cases — see the next-steps list below.
- Stage 4 (framework implementation): not started. Blocks on Stage 3.
- Stage 5 (further promotion): not started. Blocks on Stage 4.

The next actionable steps, in order, reflect the decisions above:

1. ~~**Promote `Researcher` to a multi-turn Think helper.**~~
   **Landed 2026-04-28.**
2. ~~**Parallel helper fan-out, orchestrator-driven.**~~
   **Landed 2026-04-28.** Both Alpha (LLM-driven, two `research`
   calls per turn) and Beta (programmer-driven, `compare` tool's
   `Promise.all`) are wired. Client now demuxes per
   `(parentToolCallId, helperId)`; tests cover live broadcast and
   `onConnect` replay for both shapes.
3. **Per-helper drill-in detail view** (this is the next thing we'll
   work on). Now that the helper IS a Think, drill-in becomes a real
   chat: a click on a helper panel opens a side panel that uses
   `useAgentChat({ agent: useAgent({ agent: "Assistant", name:
   DEMO_USER, sub: [{ agent: "Researcher", name: helperId }] }) })`.
   The routing is free; only the UI is missing. Confirms Option B's
   promise that drill-in is "real chat, not a custom event panel."
   Validates Ring 4's drill-in question and incidentally exposes any
   `_lastClientTools` / `_lastBody` cross-contamination (review
   item H3) the v0.2 implementation hand-waved away.

Explicitly **not** in this near-term list:

- `tablePrefix` ctor option on `ResumableStream` — closed by the
  pivot (see decision #3 above).
- `helperTool(Cls)` / `EventStreamingAgent` — Stage 4, deferred
  until the protocol is validated against multi-turn and parallel
  cases.
- AIChatAgent port — Stage 5.

After (1) and (2) land we have the empirical evidence the Stage 3
RFC needs to commit to a public name and a public API.
