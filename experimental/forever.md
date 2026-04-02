# Forever — Durable Long-Running Agents

This document describes the design of durable long-running execution for agents: surviving Durable Object eviction, recovering interrupted work (including LLM calls), and the API surface that makes this possible.

Implemented as mixins:

- `agents/experimental/forever` — `withFibers(Agent)` for durable execution (see `forever-fibers/` example)
- `@cloudflare/ai-chat/experimental/forever` — `withDurableChat(AIChatAgent)` for durable streaming (see `forever-chat/` example)

## Problem

Durable Objects get evicted for three reasons:

1. **Inactivity timeout** (~70-140 seconds with no incoming requests or open WebSockets)
2. **Code updates / runtime restarts** (non-deterministic, 1-2x per day)
3. **Alarm handler timeout** (15 minutes, controlled by `actorAlarmTimeoutMs` in WorkerLimits)

For AI agents, eviction during active work is catastrophic:

- The upstream HTTP/SSE connection to the LLM provider is **severed permanently** — you cannot resume an OpenAI or Anthropic stream mid-generation
- In-memory state (streaming buffers, partial responses, loop counters) is lost
- Connected clients see the stream stop with no explanation
- Multi-turn agent loops (tool calling, reasoning chains, orchestration) lose their position entirely

The most common real-world pattern is an agent executing many LLM turns in sequence — each turn is a normal-length call (seconds to a few minutes), but the total session can run for 15-30+ minutes. Eviction can happen between turns (losing loop position) or mid-stream (losing the active generation). Both must be handled.

A secondary pattern is agents orchestrating external long-running work (containers, sandboxes, code execution environments). Here, eviction means losing the connection to the external session, and recovery requires reconnecting and catching up on missed output (logs, results) from a known cursor position.

## Design goals

1. **Agents should be able to run indefinitely** — not bounded by DO inactivity timeouts or alarm limits
2. **Interrupted work should be recoverable** — the framework detects interruption and gives the developer a recovery hook
3. **The API should be generic** — not specific to LLM calls. Custom agent loops, orchestration, and non-AI workloads should all benefit
4. **AIChatAgent gets smart defaults** — LLM-specific recovery (message reconstruction, partial response prefill) is built on top of the generic primitives
5. **No platform changes required** — the design works with today's Durable Objects. Platform improvements (configurable alarm timeouts, outbound connection keep-alive) would help but are not assumed
6. **Reserve common names for userspace** — avoid claiming generic names like `run`, `checkpoint`, `tasks` at the framework level

## Three layers

### Layer 1: `keepAlive()` — alarm heartbeat

The simplest primitive. Keeps the DO alive by setting alarms on a short interval. No storage, no recovery semantics — just "don't go idle."

### Layer 2: Fibers — durable fire-and-forget execution

The core abstraction. A "fiber" is a method invocation that is registered in SQLite before execution, kept alive via alarm heartbeats, checkpointable, and recoverable after eviction.

### Layer 3: LLM recovery in `AIChatAgent`

Built on Layer 2. Provides intelligent defaults for the common case of interrupted LLM streaming: reconstructs messages from SQLite, uses the partial response as a prefill, and retries the generation.

## Layer 1: `keepAlive()`

### API

```typescript
class Agent {
  /**
   * Keep the Durable Object alive via alarm heartbeats.
   * Returns a function that stops the heartbeat when called.
   *
   * Use this when you have long-running work that doesn't need
   * durability/recovery semantics — you just need the DO to not
   * go idle. For durable execution, use spawnFiber() instead.
   */
  keepAlive(): Promise<() => void>;
}
```

### How it works

`keepAlive()` increments an in-memory reference counter (`_keepAliveRefs`). When the first ref is taken, `_scheduleNextAlarm()` sets an alarm via `ctx.storage.setAlarm(now + keepAliveIntervalMs)`. The alarm fires, the `alarm()` handler runs scheduled work and then calls `_onAlarmHousekeeping()` (which fibers override for recovery), and finally `_scheduleNextAlarm()` sets the next alarm if refs are still held.

The returned disposer function decrements the ref count. When all disposers have been called, `_keepAliveRefs` drops to zero and `_scheduleNextAlarm()` stops setting keepAlive alarms — the DO can go idle naturally.

No schedule rows are created in `cf_agents_schedules`. The heartbeat is invisible to `getSchedules()` and observability events.

### Key design decision: ref-counted alarms

The heartbeat uses the alarm system directly via `_scheduleNextAlarm()` rather than creating schedule rows:

- **Minimal overhead** — no SQLite writes for the heartbeat itself, just `setAlarm()` calls
- **Invisible to users** — `getSchedules()` doesn't show internal heartbeat entries
- **Alarm persistence** — since [workerd#6104](https://github.com/cloudflare/workerd/pull/6104), `ctx.storage.setAlarm()` persists to disk. If the DO is evicted or the process dies, the alarm fires on restart, triggering `_onAlarmHousekeeping()` for fiber recovery
- **The `alarm()` handler calls `_onAlarmHousekeeping()`** — so any alarm (including user schedules) also checks for interrupted fibers as a fallback

### Configurable interval

The default interval is 30 seconds (`keepAliveIntervalMs` in `static options`). The inactivity timeout is ~70-140 seconds, so 30 seconds gives comfortable margin. For testing, set a shorter interval:

```typescript
class MyAgent extends withFibers(Agent) {
  static options = { keepAliveIntervalMs: 2_000 };
}
```

### Why keep this if Layer 2 exists?

Layer 2 (fibers) involves SQLite writes, status tracking, and recovery hooks. `keepAlive()` is for cases where you just want the DO to stay alive — you're waiting on an outbound connection, doing compute, polling something — and you don't need the overhead of durable execution. It's also used internally by the fiber system.

## Layer 2: Fibers

### Terminology

A **fiber** is a method invocation on the agent that is:

- Registered in SQLite before execution begins
- Kept alive via alarm heartbeats during execution
- Checkpointable — the method can save progress at any point
- Recoverable — if the DO is evicted, the fiber is detected as interrupted on restart and a recovery hook fires

The name "fiber" evokes lightweight, resumable execution — similar to coroutines or green threads, but across process boundaries (DO eviction and restart).

### API

```typescript
class Agent {
  /**
   * Spawn a durable fiber — fire-and-forget.
   *
   * The named method is invoked with the given payload. The fiber
   * is tracked in SQLite and kept alive via alarm heartbeats.
   * If the DO is evicted, the fiber is recovered on restart.
   *
   * Returns the fiber ID (not a result — fibers are fire-and-forget
   * because the caller may not survive eviction to receive a result).
   */
  spawnFiber(
    methodName: string,
    payload?: unknown,
    options?: {
      maxRetries?: number; // default: 3
    }
  ): string;

  /**
   * Save progress for the currently executing fiber.
   * Writes to SQLite synchronously (no await needed).
   *
   * The snapshot is available in onFiberRecovered if the
   * fiber is interrupted. Each call fully replaces the
   * previous snapshot (not a merge).
   */
  stashFiber(data: unknown): void;

  /**
   * Cancel a fiber by ID. Returns true if the fiber existed
   * and was cancelled, false if not found.
   */
  cancelFiber(fiberId: string): boolean;

  /**
   * Get the current state of a fiber by ID.
   * Returns null if the fiber doesn't exist.
   */
  getFiber(fiberId: string): FiberState | null;

  /**
   * Called when a fiber completes normally.
   * Override to handle completion (e.g. persist result, notify clients).
   */
  onFiberComplete(ctx: {
    id: string;
    methodName: string;
    payload: unknown;
    result: unknown;
  }): void | Promise<void>;

  /**
   * Called per-fiber when the agent restarts and finds interrupted fibers.
   * Default: re-invokes the method with the original payload.
   *
   * Override to implement custom recovery:
   *   - Inspect the snapshot to resume from a checkpoint
   *   - Use provider-specific recovery (OpenAI background mode, Anthropic prefill)
   *   - Skip recovery and notify the user instead
   */
  onFiberRecovered(ctx: {
    id: string;
    methodName: string;
    payload: unknown;
    snapshot: unknown | null;
    retryCount: number;
  }): void | Promise<void>;

  /**
   * Called with ALL interrupted fibers when the agent restarts.
   * Default: iterates sequentially, oldest-first, calling
   * onFiberRecovered for each.
   *
   * Override for custom ordering, parallelism, or selective recovery.
   */
  onFibersRecovered(fibers: FiberRecoveryContext[]): void | Promise<void>;
}
```

### Why fire-and-forget?

`spawnFiber()` returns an ID, not a Promise that resolves with the method's return value. This is a deliberate choice:

If the DO gets evicted, whatever was awaiting the Promise is gone. There's nobody to receive the result. A Promise-based API would be a lie — it implies "you'll get the result" when in reality the caller may not survive to see it.

The honest DX is event-driven:

- **Progress** goes through `this.broadcast()` or `this.setState()` — clients learn about progress via existing real-time channels
- **Completion** fires `onFiberComplete` — the agent persists the result, notifies clients, triggers the next step, whatever
- **Recovery** fires `onFiberRecovered` — the agent decides how to resume

This also aligns with the mental model of "background work." `spawnFiber` means "start this, keep it alive, let me know when it's done or if something goes wrong."

### DX example

```typescript
class MyAgent extends Agent<Env> {
  async startResearch(topic: string) {
    const fiberId = this.spawnFiber("doResearch", { topic });
    this.broadcast({ type: "research_started", fiberId });
  }

  async doResearch(payload: { topic: string }) {
    const messages: Message[] = [];

    for (let turn = 0; turn < 20; turn++) {
      const result = await generateText({
        model: openai("gpt-4o"),
        messages: [
          { role: "system", content: "You are a research assistant." },
          ...messages,
          { role: "user", content: payload.topic }
        ]
      });

      messages.push(
        { role: "user", content: payload.topic },
        { role: "assistant", content: result.text }
      );

      // Checkpoint after each turn — if evicted, we resume from here
      this.stashFiber({
        messages,
        turnIndex: turn,
        topic: payload.topic
      });

      // Notify connected clients of progress
      this.broadcast({
        type: "research_progress",
        turn,
        text: result.text
      });
    }

    return { messages, summary: messages[messages.length - 1].content };
  }

  onFiberComplete(ctx) {
    this.setState({ researchResult: ctx.result });
    this.broadcast({ type: "research_complete", result: ctx.result });
  }

  onFiberRecovered(ctx) {
    const snapshot = ctx.snapshot as {
      messages: Message[];
      turnIndex: number;
      topic: string;
    } | null;

    if (snapshot) {
      // Resume from the last completed turn
      console.log(`Recovering research fiber at turn ${snapshot.turnIndex}`);
      // Re-invoke with the accumulated context
      this.doResearch({
        topic: snapshot.topic
        // The method would need to accept resumption context
        // (or the developer restructures to check for it)
      });
    } else {
      // No checkpoint — retry from scratch
      this.doResearch(ctx.payload);
    }
  }
}
```

### SQLite schema

```sql
CREATE TABLE IF NOT EXISTS cf_agents_fibers (
  id TEXT PRIMARY KEY,
  callback TEXT NOT NULL,       -- method name on the agent
  payload TEXT,                 -- JSON-serialized arguments
  snapshot TEXT,                -- JSON-serialized checkpoint data, set by stashFiber()
  status TEXT NOT NULL DEFAULT 'running',
    -- running:     actively executing
    -- completed:   finished successfully
    -- failed:      exhausted retries
    -- interrupted: detected as interrupted on restart (transitional)
    -- cancelled:   cancelled by cancelFiber()
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  result TEXT,                  -- JSON-serialized return value, set on completion
  error TEXT,                   -- error message, set on failure
  started_at INTEGER,           -- epoch ms
  updated_at INTEGER,           -- epoch ms, updated on every stashFiber() and status change
  completed_at INTEGER,         -- epoch ms
  created_at INTEGER NOT NULL   -- epoch ms
);
```

The table is named `cf_agents_fibers` to avoid claiming the generic `tasks` name for potential future use.

### Fiber lifecycle

#### Normal execution

```
spawnFiber("doWork", payload)
  │
  ├─ INSERT into cf_agents_fibers (status: 'running', started_at: now)
  ├─ Start keepAlive heartbeat
  ├─ Call this.doWork(payload)
  │    │
  │    ├─ this.stashFiber(data)  →  UPDATE snapshot, updated_at
  │    ├─ this.stashFiber(data)  →  UPDATE snapshot, updated_at
  │    └─ return result
  │
  ├─ UPDATE status: 'completed', result: JSON(result), completed_at: now
  ├─ Stop keepAlive heartbeat
  └─ Call this.onFiberComplete({ id, methodName, payload, result })
```

#### Eviction and recovery

```
[DO is evicted — all in-memory state lost]
  │
  ├─ Heartbeat alarm fires → DO restarts
  │
  ├─ alarm() handler runs
  │    ├─ Query cf_agents_fibers WHERE status = 'running'
  │    ├─ For each: UPDATE status: 'interrupted', retry_count: +1
  │    │
  │    ├─ If retry_count <= max_retries:
  │    │    └─ Call this.onFibersRecovered(fibers)
  │    │         └─ Default: for each fiber, call this.onFiberRecovered(ctx)
  │    │              └─ Default: re-invoke the method with original payload
  │    │
  │    └─ If retry_count > max_retries:
  │         └─ UPDATE status: 'failed', error: 'max retries exceeded'
  │              (developer can handle in onError or query failed fibers)
  │
  └─ If recovery re-invokes the method:
       ├─ UPDATE status: 'running', started_at: now
       ├─ Start keepAlive heartbeat
       └─ (normal execution continues from here)
```

#### Error during execution (no eviction)

```
this.doWork(payload) throws Error
  │
  ├─ UPDATE retry_count: +1
  ├─ If retry_count <= max_retries:
  │    └─ Re-invoke the method (immediate retry)
  └─ If retry_count > max_retries:
       ├─ UPDATE status: 'failed', error: error.message
       └─ Stop keepAlive heartbeat
```

### `stashFiber()` — checkpoint semantics

`stashFiber(data)` writes to SQLite synchronously via `this.sql` (which calls `ctx.storage.sql.exec()`). There is no async gap between "I decided to save" and "it's saved." If eviction happens after `stashFiber` returns, the data is guaranteed to be in SQLite.

Each call **fully replaces** the previous snapshot — it's not a merge. The developer writes the complete recovery state they need. This is simpler to reason about than partial updates and avoids subtle bugs where stale fields linger.

The snapshot is arbitrary JSON. Common patterns:

**Single cursor (LLM streaming):**

```typescript
this.stashFiber({
  responseId: "resp_abc123", // for OpenAI background mode retrieval
  chunksReceived: 47,
  partialText: "The analysis shows..."
});
```

**Multiple cursors (orchestrating external sessions):**

```typescript
this.stashFiber({
  cursors: {
    sandbox: { sessionId: "sess_xyz", lastLogId: "log_789" },
    llmStream: { responseId: "resp_abc", lastChunkIndex: 42 },
  },
  turnIndex: 14,
  accumulatedMessages: [...],
});
```

**Loop position (multi-turn agent):**

```typescript
this.stashFiber({
  completedSteps: ["search", "analyze"],
  pendingSteps: ["synthesize", "review"],
  intermediateResults: { search: [...], analyze: [...] },
});
```

### Stash frequency tradeoffs

How often to call `stashFiber()` is a tradeoff:

| Strategy             | Writes                               | Data loss on eviction   |
| -------------------- | ------------------------------------ | ----------------------- |
| Every LLM chunk      | Many (could be hundreds/s)           | Minimal (last chunk)    |
| Every N seconds      | Moderate                             | Up to N seconds of work |
| After each turn/step | Few                                  | Up to one full turn     |
| On buffer flush      | Moderate (piggyback on existing I/O) | Up to buffer size       |

For multi-turn agents, stashing after each turn is the natural choice — each turn is a logical checkpoint and the write frequency is low (seconds to minutes between turns).

For streaming, stashing every chunk is excessive. A practical approach: stash periodically (every few seconds or every N chunks), or piggyback on existing buffer flushes. In `AIChatAgent`, the stream chunk persistence (`cf_ai_chat_stream_chunks`) already captures individual chunks — the fiber snapshot only needs to store enough metadata to _find_ those chunks on recovery (stream ID, request ID), not duplicate the full text.

### Concurrency

Multiple fibers can run concurrently on the same agent. This is supported, not artificially limited.

**Alarm coordination:** Each fiber calls `keepAlive()`, which ref-counts `_keepAliveRefs`. The disposer is called when the fiber completes or fails. When all fibers are done, `_keepAliveRefs` drops to zero and `_scheduleNextAlarm()` stops setting keepAlive alarms — the DO can go idle.

**Recovery ordering:** When the agent restarts with multiple interrupted fibers, `onFibersRecovered` is called with all of them. The default implementation recovers them **sequentially, oldest-first by creation time**:

```typescript
async onFibersRecovered(fibers: FiberRecoveryContext[]) {
  for (const fiber of fibers) {
    await this.onFiberRecovered(fiber);
  }
}
```

Developers who need custom ordering override `onFibersRecovered`:

```typescript
async onFibersRecovered(fibers) {
  // Prioritize chat fibers, then background work
  const chat = fibers.filter(f => f.methodName === "handleChat");
  const background = fibers.filter(f => f.methodName !== "handleChat");

  // Recover chat fibers first, in parallel
  await Promise.all(chat.map(f => this.onFiberRecovered(f)));

  // Then background fibers sequentially
  for (const f of background) {
    await this.onFiberRecovered(f);
  }
}
```

Or skip certain fibers:

```typescript
async onFibersRecovered(fibers) {
  for (const fiber of fibers) {
    if (fiber.retryCount > 2) {
      console.warn(`Giving up on fiber ${fiber.id}`);
      // Mark as failed by not recovering — framework handles status update
      continue;
    }
    await this.onFiberRecovered(fiber);
  }
}
```

**Snapshot isolation:** Each fiber has its own `snapshot` column in `cf_agents_fibers`, keyed by fiber ID. `stashFiber()` writes to the currently executing fiber (tracked via `AsyncLocalStorage`). There are no cross-fiber snapshot conflicts.

**Resource contention:** Multiple concurrent fibers means multiple outbound HTTP connections, more memory, more SQLite writes. This is a practical concern but not an architectural one — the environment (Workers runtime) manages resource limits. The framework doesn't impose artificial concurrency limits.

### Interaction with the alarm system

Fibers use the alarm system via ref-counted `keepAlive()`:

1. When a fiber is spawned, `_startFiber()` calls `keepAlive()`, which increments `_keepAliveRefs` and calls `_scheduleNextAlarm()`
2. `_scheduleNextAlarm()` sets `ctx.storage.setAlarm(now + keepAliveIntervalMs)` — this persists to disk and survives eviction
3. When the alarm fires, `alarm()` processes schedules, then calls `_onAlarmHousekeeping()` (overridden by the fiber mixin to run `_checkInterruptedFibers()`)
4. `_checkInterruptedFibers()` finds rows with `status = 'running'` that aren't in the in-memory `_fiberActiveFibers` set — these are eviction survivors
5. At the end of `alarm()`, `_scheduleNextAlarm()` sets the next alarm if refs are still held

The only modification to the base `Agent` is the `_onAlarmHousekeeping()` hook — an empty virtual method that the fiber mixin overrides. `alarm()` and `_scheduleNextAlarm()` are otherwise untouched.

### The 15-minute alarm timeout

The alarm handler has a timeout of ~15 minutes (`actorAlarmTimeoutMs`). For this design, this is largely a non-issue because:

1. The alarm handler **doesn't run the fiber's work**. It detects interrupted fibers and re-invokes methods. The actual LLM calls happen in the method execution context, not the alarm handler.
2. Each alarm handler invocation gets a fresh timeout window.
3. The heartbeat alarm fires every `keepAliveIntervalMs` (default 30s) — the handler runs for milliseconds (a few SQL queries + setting the next alarm), well within any timeout.

The scenario where the 15-minute limit matters: a fiber method itself runs for over 15 minutes continuously without the DO being kept alive by other means (incoming requests, open WebSockets). Since the heartbeat alarm is what keeps the DO alive, and alarm handlers get 15 minutes, and our handler finishes in milliseconds and re-schedules, the DO stays alive indefinitely through alarm chaining.

If a platform change makes `actorAlarmTimeoutMs` configurable or adds a "top up" API in the future, that would provide additional safety margin but is not required for this design.

## Layer 3: LLM recovery in `AIChatAgent`

### What LLM providers offer for recovery

#### OpenAI — Background mode + response retrieval

OpenAI's Responses API supports `store: true`, which persists the response server-side. If the client connection drops, the generation continues on OpenAI's servers. The completed response can be retrieved later via `GET /v1/responses/{response_id}`.

This is the **best recovery path** — no tokens are wasted, no quality degradation. The generation finished; you just need to fetch it.

Recovery pattern:

1. During fiber execution, stash the response ID immediately after creating the request
2. On recovery, call `GET /v1/responses/{response_id}`
3. If the response completed, use it directly — no re-generation needed
4. If the response is still in progress or failed, fall back to retry

#### Anthropic — Prefill continuation

Anthropic's Messages API supports "prefilling" — including partial assistant text as an assistant message in the conversation. The model continues from that exact point.

Recovery pattern:

1. During fiber execution, stash partial text periodically
2. On recovery, reconstruct messages with the partial text as an assistant message
3. Append a user message like "Continue from where you left off."
4. The model picks up roughly where it stopped

This is **second-best** — some tokens are spent re-reading the partial, but the user gets a coherent continuation rather than starting from scratch.

#### Google Gemini and others — No recovery mechanism

No documented recovery API. The recommended approach is retry with backoff.

Recovery pattern:

1. On recovery, simply re-invoke the LLM call from scratch
2. The conversation history (persisted in SQLite) means the model has full context
3. Only the last in-flight generation is lost and retried

This is **degraded but functional** — the conversation state is preserved, only the last generation is repeated.

### Partial response as prefill — the universal fallback

The Anthropic prefill pattern works across all providers because it's just message formatting — you're adding an assistant message with the partial text followed by a user message asking the model to continue. Most models handle this well, even those without explicit prefill support.

The default `AIChatAgent.onFiberRecovered` should use this pattern:

1. Load persisted messages from `cf_ai_chat_agent_messages`
2. Load partial response from `cf_ai_chat_stream_chunks` (already persisted during streaming)
3. Reconstruct the conversation with the partial response as an assistant prefill
4. Re-invoke `onChatMessage` with the reconstructed messages

```typescript
// Reconstructed messages for recovery
[
  ...originalMessages, // from SQLite
  { role: "assistant", content: partialTextFromChunks }, // from stream chunks
  { role: "user", content: "Continue from where you left off." }
];
```

Power users override `onFiberRecovered` to use provider-specific optimizations (OpenAI background mode retrieval, custom prefill prompts, etc.).

### Integration with existing `AIChatAgent` streaming

**Status: NOT YET IMPLEMENTED.** The changes below are planned. The AIChatAgent code is being refactored in a separate branch first. This section documents the design and the concrete code changes to make when ready.

`AIChatAgent` already has significant infrastructure for stream persistence:

| Existing feature         | Table                        | Purpose                                         |
| ------------------------ | ---------------------------- | ----------------------------------------------- |
| Stream chunk persistence | `cf_ai_chat_stream_chunks`   | Individual chunks saved during streaming        |
| Stream metadata tracking | `cf_ai_chat_stream_metadata` | Tracks active/completed/error streams           |
| Message persistence      | `cf_ai_chat_agent_messages`  | Full conversation history                       |
| Client resumption        | (in-memory + WebSocket)      | Replays buffered chunks to reconnecting clients |

What the Layer 3 integration will add:

| New capability              | Mechanism                              | Purpose                                                   |
| --------------------------- | -------------------------------------- | --------------------------------------------------------- |
| Keep-alive during streaming | `keepAlive()` in `_reply()`            | DO doesn't go idle during long generations                |
| Interruption detection      | `_restoreActiveStream()` + stale check | Detects streams left in 'streaming' status after eviction |
| Recovery hook               | `onStreamInterrupted(context)`         | User implements recovery strategy (prefill, retry, etc.)  |
| Partial text extraction     | `getPartialStreamText()`               | Public method to reconstruct partial response from chunks |

### Design decision: hooks over fiber wrapping

We chose NOT to wrap the `onChatMessage` + `_reply` flow in a fiber. The reasons:

1. **The `Response` object isn't serializable** — `spawnFiber` stores its payload in SQLite as JSON. A `Response` with a `ReadableStream` body can't be serialized. The fiber would need to call `onChatMessage` fresh on recovery, but `onChatMessage` requires `onFinish` callbacks and options (abort signals, client tools) that are difficult to reconstruct.

2. **`_reply` is deeply coupled to connection state** — it tracks streaming messages, broadcasts to WebSocket connections, manages abort controllers. A fiber running in the background without a connection context would miss all of this.

3. **`keepAlive()` solves the immediate problem** — the most common failure mode is "DO goes idle during a long LLM stream." `keepAlive()` in `_reply` prevents this with zero API changes.

4. **`onStreamInterrupted` gives users control** — different providers need different recovery strategies (OpenAI background mode vs. Anthropic prefill vs. plain retry). A hook with the partial text and messages is more useful than an opinionated default.

### Concrete code changes to make

#### 1. Add `keepAlive()` in `_reply()` — `packages/ai-chat/src/index.ts`

Call `await this.keepAlive()` at the top of `_reply` and dispose in `.finally()`. This is the single biggest win — prevents idle eviction during streaming with no API changes.

```typescript
private async _reply(id, response, excludeBroadcastIds, options) {
  const disposeKeepAlive = await this.keepAlive();
  return this._tryCatchChat(async () => {
    // ... existing streaming logic ...
  }).finally(() => {
    disposeKeepAlive();
  });
}
```

#### 2. Add `getPartialStreamText()` public method — `packages/ai-chat/src/index.ts`

Extracts partial response from the most recent stream's persisted chunks. Can use `ResumableStream`'s SQL interface to query chunks, and optionally `applyChunkToParts` from `message-builder.ts` for robust parsing (handles reasoning, tool calls, not just text-delta).

#### 3. Add `onStreamInterrupted(context)` hook — `packages/ai-chat/src/index.ts`

Overridable hook called when a stale/interrupted stream is detected. Context provides:

- `partialText` — from `getPartialStreamText()`
- `messages` — all persisted messages (`this.messages`)
- `streamId` / `requestId` — for correlation
- `lastBody` — the original custom body from `_lastBody` (now persisted!)
- `lastClientTools` — the original client tools from `_lastClientTools` (now persisted!)

Having `lastBody` and `lastClientTools` available makes re-calling `onChatMessage` straightforward:

```typescript
async onStreamInterrupted(ctx) {
  const response = await this.onChatMessage(() => {}, {
    clientTools: ctx.lastClientTools,
    body: ctx.lastBody
  });
  if (response) await this._reply(ctx.requestId, response, [], { continuation: true });
}
```

#### 4. Modify stale stream handling — `packages/ai-chat/src/resumable-stream.ts`

In `ResumableStream.restore()`, change stale stream handling from deleting to marking as `'error'` and returning the stream info so `AIChatAgent._restoreActiveStream()` can fire the `onStreamInterrupted` hook. The existing test `"deletes stale streams on restore"` in `resumable-streaming.test.ts` will need updating.

### AIChatAgent refactor (merged to main) — what changed

A major refactor of AIChatAgent was completed on `main`. These changes significantly affect the Layer 3 plan. Key findings:

#### Prerequisites now resolved

1. **Request context persists across hibernation** (DONE) — `_lastBody` and `_lastClientTools` are now stored in a `cf_ai_chat_request_context` SQLite table and restored in the constructor. This was the biggest blocker — on recovery, we now have the original request context needed to re-call `onChatMessage`. No need for a separate `retryLastGeneration()` method.

2. **`onFinish` is now optional** (DONE) — the framework handles abort controller cleanup and observability automatically. This means `onChatMessage` can be re-called programmatically with just `await this.onChatMessage(() => {})` — no complex callback reconstruction needed.

3. **Stream chunk persistence separated** (DONE) — extracted to standalone `ResumableStream` class in `resumable-stream.ts`. Clean separation of chunk buffering, persistence, and replay from the main agent logic.

4. **Shared message parser** (DONE) — `message-builder.ts` provides `applyChunkToParts()` for parsing SSE events into UIMessage parts. Could be used by `getPartialStreamText()` instead of hand-rolling text-delta extraction.

#### Prerequisites still needed

1. **Configurable stale threshold** — `STREAM_STALE_THRESHOLD_MS` (5 minutes) is still hardcoded in `resumable-stream.ts`. Should be configurable via `static options`.

2. **Provider-specific recovery helpers** — utility functions for prefill construction, OpenAI response retrieval, etc.

#### New architecture to account for

The code changes in section "Concrete code changes" need updating:

- **`_restoreActiveStream()`** now delegates to `this._resumableStream.restore()` — the stale stream detection logic is in `ResumableStream`, not `AIChatAgent` directly. The `onStreamInterrupted` hook needs to be triggered from within `ResumableStream.restore()` or after it returns.

- **`_reply()`** signature changed to `_reply(id, response, excludeBroadcastIds, { continuation?, chatMessageId? })`. The `keepAlive()` integration point is the same.

- **`message-builder.ts`** — `getPartialStreamText()` could use `applyChunkToParts` from this module for more robust text extraction (handles reasoning parts, tool calls, etc., not just text-delta).

- **New tables** — `cf_ai_chat_request_context` stores `lastBody` and `lastClientTools`. These survive hibernation and would be available during recovery.

- **`ws-chat-transport.ts`** — new WebSocket-based ChatTransport on the client. Replaces the old aiFetch approach. Stream resumption flows may have changed on the client side.

- **E2E test infrastructure** — `packages/ai-chat/e2e/` now has Playwright-based tests with a wrangler dev server. Could be extended for fiber recovery e2e tests with real LLM calls.

### How recovery will work

```
[DO evicted during AIChatAgent streaming]
  │
  ├─ SQLite persists:
  │    - cf_ai_chat_agent_messages (full conversation)
  │    - cf_ai_chat_stream_chunks (partial response chunks)
  │    - cf_ai_chat_stream_metadata (status = 'streaming')
  │
  ├─ DO restarts (from alarm, HTTP request, or WebSocket)
  │
  ├─ Constructor calls _restoreActiveStream()
  │    ├─ Finds stream with status = 'streaming'
  │    ├─ Stream is older than 5 minutes → marks as 'error'
  │    ├─ Calls getPartialStreamText() → extracts text from chunks
  │    └─ Fires onStreamInterrupted({ partialText, messages, streamId, requestId })
  │
  └─ User's onStreamInterrupted implementation:
       ├─ Constructs prefill: [...messages, { role: "assistant", content: partialText }]
       ├─ Adds continuation prompt: { role: "user", content: "Continue." }
       ├─ Calls this.onChatMessage() → new LLM generation starts
       └─ Response streams to connected clients as normal
```

## External session reconnection

For agents orchestrating external long-running work (containers, sandboxes, code execution), the pattern is:

1. **Stash cursor positions** — the fiber checkpoints include session IDs and log cursors for all active external sessions
2. **Reconnect on recovery** — `onFiberRecovered` uses the stashed session IDs to reconnect
3. **Catch up from cursor** — request logs/output from the external service starting from the last known cursor position

This requires the external service to support cursor-based log retrieval (e.g., "give me logs from this timestamp/ID onwards"). The agents SDK doesn't implement this — it provides the storage and recovery hooks. The external service contract is the developer's responsibility.

```typescript
async onFiberRecovered(ctx) {
  const { cursors } = ctx.snapshot;

  // Reconnect to the sandbox
  const sandbox = await reconnectToSandbox(cursors.sandbox.sessionId);

  // Catch up on missed logs
  const missedLogs = await sandbox.getLogsSince(cursors.sandbox.lastLogId);
  for (const log of missedLogs) {
    this.broadcast({ type: "log", ...log });
  }

  // Continue orchestration from the last checkpoint
  await this.continueOrchestration(ctx.payload, cursors);
}
```

Multiple cursors are naturally supported because `stashFiber` accepts arbitrary JSON. Each external session gets its own cursor within the snapshot object.

## Tradeoffs

### Fire-and-forget vs. Promise-based

We chose fire-and-forget because a Promise implies "you'll get the result" — but the caller may not survive eviction. The tradeoff is that the DX is more event-driven (hooks and broadcasts rather than await). This is unfamiliar to developers used to `const result = await doWork()`, but it's the honest API for work that may outlive its caller.

### Recovery is opt-in behavior, not automatic resumption

`onFiberRecovered`'s default is to re-invoke the method from scratch. It doesn't magically resume mid-function. True resumption would require serializing the entire call stack, which isn't feasible in JavaScript. The developer must structure their code to be resumable — by checking the snapshot and skipping completed work. This is more effort but gives the developer full control over recovery behavior.

### `stashFiber` is synchronous but single-writer

`stashFiber()` writes to SQLite synchronously, which is great for durability (no gap between save and persist). But if two concurrent fibers somehow called `stashFiber` simultaneously, they'd write to different rows (each fiber has its own row), so there's no conflict. The `stashFiber` call knows which fiber is executing via the fiber execution context.

### Per-fiber snapshots vs. shared state

Each fiber has its own snapshot, separate from the agent's `state`. This is intentional — fibers are independent units of work, and their checkpoints shouldn't interfere with each other or with the agent's shared state. The agent's `state` (via `setState`) is for client-visible shared state. Fiber snapshots are for internal recovery data.

### Heartbeat implementation: ref-counted alarms

The keepAlive heartbeat uses ref-counted alarm scheduling via `_scheduleNextAlarm()`. When `_keepAliveRefs > 0`, `_scheduleNextAlarm()` ensures an alarm is set within `keepAliveIntervalMs`. The fiber mixin adds an `_onAlarmHousekeeping()` override that runs `_checkInterruptedFibers()` on every alarm.

This approach is minimally invasive — `_scheduleNextAlarm()` has a single `if (_keepAliveRefs > 0)` branch, and the `_onAlarmHousekeeping()` hook is an empty virtual method in the base class. No schedule rows are created; the heartbeat is invisible to `getSchedules()`. The alarm persists to disk via `ctx.storage.setAlarm()`, so it survives eviction and process restarts.

### No automatic partial response detection

The framework doesn't automatically detect "this looks like an interrupted LLM response" and prefill it. That logic lives in `AIChatAgent`'s `onFiberRecovered` override. For the base `Agent` class, recovery is generic — the developer decides what the snapshot means and how to use it. This keeps the base class simple and avoids coupling it to LLM-specific concerns.

## Resolved design decisions

These were originally open questions; the implementation chose:

- **`stashFiber` context tracking:** Uses `AsyncLocalStorage`. A fiber ID is set in the async context before invoking the method. `stashFiber()` reads it. Concurrent fibers each have their own context — no conflicts.
- **Fiber method signature:** Option B — the method receives `(payload, fiberCtx: FiberContext)` where `fiberCtx` has `{ id, snapshot, retryCount }`. This lets the method itself resume from a checkpoint without needing a separate `onFiberRecovered` override.
- **Cleanup of completed fibers:** TTL-based via `_maybeCleanupFibers()`. Completed fibers are deleted after 24 hours, failed after 7 days, cancelled after 24 hours. Cleanup runs on each `spawnFiber()` call, throttled to every 10 minutes.
- **Debug logging:** `withFibers(Agent, { debugFibers: true })` enables `console.debug` for fiber lifecycle events. No observability events — debug logging is the sole mechanism while the API stabilizes.

### Local dev: alarms persist across process restart

Since [cloudflare/workerd#6104](https://github.com/cloudflare/workerd/pull/6104), workerd persists alarm state to disk. This means alarms set before a process kill survive the restart and fire automatically — matching production behavior. Local development and production now behave identically for fiber recovery:

1. Fiber is spawned, `keepAlive()` sets an alarm via `ctx.storage.setAlarm()`
2. Process is killed (SIGKILL, code update, etc.)
3. Process restarts — workerd reads persisted alarm state from disk
4. Alarm fires automatically → `alarm()` → `_onAlarmHousekeeping()` → `_checkInterruptedFibers()` → recovery

The e2e test in `packages/agents/src/e2e-tests/` validates this: it spawns a fiber, kills the wrangler process with SIGKILL, restarts with the same persist directory, and verifies the fiber recovers and completes automatically — no manual `triggerAlarm()` call needed.

**Note for local demos:** The `forever-fibers/` example still uses a "Simulate Kill & Recover" button because we can't truly kill a running async function from JavaScript in the same process. For real eviction testing, kill the wrangler process externally.
