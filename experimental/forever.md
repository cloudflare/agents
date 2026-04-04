# Forever — Durable Long-Running Agents

How agents survive Durable Object eviction, recover interrupted work, and run indefinitely.

See the `forever-fibers/` example for standalone fiber usage, and `forever-chat/` for LLM streaming recovery.

## Problem

Durable Objects get evicted for three reasons:

1. **Inactivity timeout** (~70-140 seconds with no incoming requests or open WebSockets)
2. **Code updates / runtime restarts** (non-deterministic, 1-2x per day)
3. **Alarm handler timeout** (15 minutes)

For AI agents, eviction during active work is catastrophic:

- The upstream HTTP/SSE connection to the LLM provider is severed permanently — you cannot resume an OpenAI or Anthropic stream mid-generation
- In-memory state (streaming buffers, partial responses, loop counters) is lost
- Connected clients see the stream stop with no explanation
- Multi-turn agent loops (tool calling, reasoning chains, orchestration) lose their position entirely

The most common pattern is an agent executing many LLM turns in sequence — each turn is normal-length (seconds to a few minutes), but the total session can run 15-30+ minutes. Eviction can happen between turns (losing loop position) or mid-stream (losing the active generation). Both must be handled.

## Architecture

Two layers, both built into the `Agent` base class:

| Layer | Primitive     | Purpose                                                               |
| ----- | ------------- | --------------------------------------------------------------------- |
| 1     | `keepAlive()` | Prevents idle eviction via alarm heartbeats                           |
| 2     | `runFiber()`  | Durable execution — registered in SQLite, checkpointable, recoverable |

`AIChatAgent` builds on Layer 2 to provide chat-specific recovery: it wraps each chat turn in a fiber, detects interruptions, and exposes `onChatRecovery` for provider-specific continuation strategies.

## Layer 1: `keepAlive()`

### API

```typescript
class Agent {
  keepAlive(): Promise<() => void>;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
}
```

`keepAlive()` returns a disposer function. Call it when you're done. `keepAliveWhile()` is a convenience wrapper that disposes automatically when the async function completes.

### How it works

Ref-counted alarms. `keepAlive()` increments `_keepAliveRefs`. When the first ref is taken, `_scheduleNextAlarm()` sets an alarm via `ctx.storage.setAlarm(now + keepAliveIntervalMs)`. The alarm fires, runs scheduled work and housekeeping, then sets the next alarm if refs are still held. When all disposers are called, `_keepAliveRefs` drops to zero and alarms stop — the DO can go idle naturally.

No schedule rows are created in `cf_agents_schedules`. The heartbeat is invisible to `getSchedules()`.

### Alarm persistence

`ctx.storage.setAlarm()` persists to disk. If the DO is evicted or the process dies, recovery runs eagerly in `onStart()` on the first request after wake. The persisted alarm serves as a fallback — `_onAlarmHousekeeping()` also calls `_checkRunFibers()`, with a re-entrancy guard preventing double recovery.

### Configurable interval

Default: 30 seconds. The inactivity timeout is ~70-140 seconds, so 30 seconds gives comfortable margin. For testing:

```typescript
class MyAgent extends Agent {
  static options = { keepAliveIntervalMs: 2_000 };
}
```

### Why keep this if Layer 2 exists?

`runFiber()` involves SQLite writes and recovery hooks. `keepAlive()` is for cases where you just want the DO to stay alive — waiting on an outbound connection, doing compute, polling — without the overhead of durable execution. It's also used internally by `runFiber()`.

## Layer 2: `runFiber()`

### API

```typescript
class Agent {
  /**
   * Execute a durable fiber. Registered in SQLite before execution,
   * kept alive via alarm heartbeats, checkpointable, and recoverable
   * after eviction.
   *
   * Inline (await result) or fire-and-forget (void this.runFiber(...)).
   */
  runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>;

  /**
   * Checkpoint data for the currently active fiber.
   * Convenience method — delegates to the most recently started fiber.
   * Throws if no fiber or multiple concurrent fibers are active.
   */
  stash(data: unknown): void;

  /**
   * Called when an interrupted fiber is detected after restart.
   * Override to implement recovery.
   * Default: logs a warning.
   */
  onFiberRecovered(ctx: FiberRecoveryContext): Promise<void>;
}

type FiberContext = {
  id: string;
  stash(data: unknown): void;
  snapshot: unknown | null;
};

type FiberRecoveryContext = {
  id: string;
  name: string;
  snapshot: unknown | null;
};
```

### Design: lambda over method name

The old experimental API used `spawnFiber("methodName", payload)` — fire-and-forget, method-name-based. `runFiber()` takes a lambda instead:

```typescript
// Old (deleted)
this.spawnFiber("doResearch", { topic });

// New
await this.runFiber("research", async (ctx) => {
  // inline code with closure access to `this`
  ctx.stash({ progress: 50 });
  return result;
});
```

Lambdas are better because:

- **Inline awaiting** — you can `await runFiber()` and get the return value. If the DO is evicted before completion, the caller is gone — recovery happens through `onFiberRecovered`, not by returning a value. But most fibers complete within their first run, so inline await is a useful convenience.
- **Closure access** — the function captures `this` and local variables naturally. No need to serialize a payload to JSON and reconstruct it in a separate method.
- **Fire-and-forget still works** — `void this.runFiber(...)` is the fire-and-forget pattern. For long-running work that is likely to outlive a single DO lifetime, fire-and-forget with checkpoint/recovery is the safer pattern.
- **No method-name coupling** — fiber recovery uses the `name` parameter for filtering, not a method name. The lambda is gone on recovery; the snapshot carries the state.

### SQLite schema

```sql
CREATE TABLE IF NOT EXISTS cf_agents_runs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  snapshot TEXT,
  created_at INTEGER NOT NULL
);
```

Minimal. A row exists only while a fiber is running. On completion (normal or error), the row is deleted. The `name` field is for identification in recovery — not a method reference.

Compare to the old `cf_agents_fibers` table which had 12 columns (status, retry_count, max_retries, result, error, started_at, updated_at, completed_at, callback, payload...). Most of that state was never needed — fibers either complete or get interrupted, and recovery logic belongs in the developer's hook, not framework-managed status fields.

### Fiber lifecycle

#### Normal execution

```
runFiber("work", fn)
  │
  ├─ INSERT into cf_agents_runs (id, name, snapshot: NULL, created_at)
  ├─ keepAlive() → alarm heartbeat starts
  ├─ Execute fn(ctx)
  │    ├─ ctx.stash(data)  →  UPDATE snapshot
  │    ├─ ctx.stash(data)  →  UPDATE snapshot
  │    └─ return result
  │
  ├─ DELETE from cf_agents_runs
  ├─ keepAlive dispose → heartbeat stops
  └─ Return result to caller
```

#### Eviction and recovery

```
[DO evicted — all in-memory state lost]
  │
  ├─ First request/connection → onStart() → _checkRunFibers()  [primary]
  │  OR
  ├─ Heartbeat alarm fires → _onAlarmHousekeeping() → _checkRunFibers()  [fallback]
  │
  ├─ _checkRunFibers() (runs once — re-entrancy guard prevents double recovery)
  │    │
  │    ├─ SELECT * FROM cf_agents_runs
  │    ├─ For each row NOT in _runFiberActiveFibers (in-memory set):
  │    │    ├─ Parse snapshot from JSON
  │    │    ├─ Call _handleInternalFiberRecovery(ctx)
  │    │    │    └─ If handled (returns true): skip user hook
  │    │    ├─ Otherwise: call onFiberRecovered(ctx)
  │    │    └─ DELETE the row
  │    │
  │    └─ If developer re-invokes runFiber in the hook:
  │         └─ New row created → normal execution continues
```

#### Error during execution

```
fn(ctx) throws Error
  │
  ├─ DELETE from cf_agents_runs
  ├─ keepAlive dispose
  └─ Error propagates to caller (or logged if fire-and-forget)
```

No automatic retries. The old API had `maxRetries` with automatic retry loops — in practice, nobody used them, and retry logic is better left to the developer's recovery hook where they have full context about what went wrong.

### `ctx.stash()` — checkpoint semantics

`ctx.stash(data)` writes to SQLite synchronously via `this.sql`. No async gap between "I decided to save" and "it's saved." If eviction happens after `stash()` returns, the data is guaranteed to be in SQLite.

Each call **fully replaces** the previous snapshot — it's not a merge. The developer writes the complete recovery state they need.

Common patterns:

```typescript
// Loop position
ctx.stash({
  completedSteps: ["search", "analyze"],
  pendingSteps: ["synthesize", "review"],
  intermediateResults: { search: [...], analyze: [...] }
});

// Provider-specific recovery data
ctx.stash({
  responseId: "resp_abc123"  // for OpenAI Responses API retrieval
});

// External session cursors
ctx.stash({
  cursors: {
    sandbox: { sessionId: "sess_xyz", lastLogId: "log_789" },
    llmStream: { responseId: "resp_abc", lastChunkIndex: 42 }
  }
});
```

**`this.stash()` vs `ctx.stash()`:** `this.stash(data)` is a convenience that uses `AsyncLocalStorage` to find the currently executing fiber and delegates to its `stash`. It works correctly even with concurrent fibers — each fiber's ALS context is independent. It throws if called outside a `runFiber` callback. `ctx.stash()` is equivalent but doesn't require ALS — it's a direct closure over the fiber ID.

### Concurrency

Multiple fibers can run concurrently. Each calls `keepAlive()` independently — ref-counted, so the DO stays alive until all fibers complete. Each fiber has its own row in `cf_agents_runs` with its own snapshot. `ctx.stash()` writes to the correct row via closure capture.

On recovery, `_checkRunFibers()` iterates all orphaned rows and calls the recovery hook for each. The developer controls ordering and parallelism in their `onFiberRecovered` implementation.

### DX example

```typescript
class ResearchAgent extends Agent {
  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "research") return;

    const snapshot = ctx.snapshot as {
      topic: string;
      completedSteps: string[];
    } | null;

    if (snapshot) {
      // Resume from checkpoint
      void this._doResearch(snapshot.topic, snapshot.completedSteps);
    }
  }

  async startResearch(topic: string) {
    void this.runFiber("research", async (ctx) => {
      const steps = ["search", "analyze", "synthesize"];
      const completed: string[] = [];

      for (const step of steps) {
        const result = await this._executeStep(step, topic);
        completed.push(step);

        ctx.stash({ topic, completedSteps: completed });

        this.broadcast(
          JSON.stringify({
            type: "progress",
            step,
            result
          })
        );
      }

      this.broadcast(JSON.stringify({ type: "complete" }));
    });
  }
}
```

## Layer 3: Chat recovery in `AIChatAgent`

`AIChatAgent` wraps each chat turn in a fiber when `durableStreaming` is enabled. This provides automatic keepAlive during LLM streaming and a recovery path when the DO is evicted mid-stream.

### How it works

1. When a chat message arrives, `AIChatAgent` wraps `onChatMessage` + `_reply` in `runFiber("__cf_internal_chat_turn:{requestId}", ...)`.
2. The fiber holds a `keepAlive()` ref for the duration — the DO won't go idle during long LLM responses.
3. If the DO is evicted mid-stream, the fiber row survives in SQLite.
4. On restart, `_handleInternalFiberRecovery` detects the chat fiber, extracts `requestId` from the name, looks up stream chunks from `cf_ai_chat_stream_metadata`, and calls `onChatRecovery`.
5. `onChatRecovery` returns options controlling what happens next.

### API

```typescript
class AIChatAgent {
  /** Enable fiber wrapping for chat turns. */
  protected durableStreaming = false;

  /**
   * Called when an interrupted chat stream is detected.
   * Return options to control recovery:
   *
   * - {} (default): persist partial response + schedule continuation
   * - { continue: false }: persist but don't continue
   * - { persist: false, continue: false }: handle everything yourself
   */
  protected onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions>;

  /** Append to the last assistant message by re-calling onChatMessage. */
  protected continueLastTurn(
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult>;
}

type ChatRecoveryContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  recoveryData: unknown | null; // snapshot data from this.stash()
  messages: ChatMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
};

type ChatRecoveryOptions = {
  persist?: boolean; // save partial response. Default: true
  continue?: boolean; // schedule continuation. Default: true
};
```

### Snapshot ownership

The `requestId` is encoded in the fiber name (`__cf_internal_chat_turn:{requestId}`), not in the snapshot. This means the snapshot is entirely the user's domain — calling `this.stash({ responseId })` inside `onChatMessage` won't overwrite framework data. On recovery, `recoveryData` in `ChatRecoveryContext` contains whatever the user stashed.

### Recovery strategies by provider

| Provider   | Strategy                                 | How                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers AI | Persist partial + inline continuation    | Default behavior. `continueLastTurn()` re-calls `onChatMessage`; the model continues from the conversation history.                                                                                                                 |
| OpenAI     | Retrieve completed response              | `store: true` in Responses API. Stash the `responseId` via `this.stash()`. In `onChatRecovery`, call `GET /v1/responses/{id}` to retrieve the completed generation. Return `{ persist: false, continue: false }`.                   |
| Anthropic  | Persist partial + synthetic user message | Anthropic doesn't support assistant prefill for continuation. Schedule a `saveMessages` with a synthetic user message ("Continue where you left off"), with reasoning disabled for the recovery call. Return `{ continue: false }`. |

### Example: multi-provider recovery

```typescript
class MyChat extends AIChatAgent<Env> {
  protected override durableStreaming = true;

  override async onChatRecovery(ctx: ChatRecoveryContext) {
    const provider = this.state?.lastProvider;

    if (provider === "openai") {
      const responseId = (ctx.recoveryData as { responseId?: string })?.responseId;
      if (responseId) {
        const text = await this._fetchOpenAIResponse(responseId);
        if (text) {
          this.persistMessages([...this.messages, {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text }]
          }]);
          return { persist: false, continue: false };
        }
      }
    }

    if (provider === "anthropic") {
      await this.schedule(0, "_continueWithSyntheticMessage");
      return { continue: false };
    }

    // Workers AI / default: persist partial + auto-continue
    return {};
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const provider = options?.body?.provider ?? "workersai";

    if (provider === "openai") {
      // Capture responseId for recovery
      const result = streamText({
        model: openai("gpt-5.4"),
        messages: ...,
        providerOptions: { openai: { store: true } },
        includeRawChunks: true,
        onChunk: ({ chunk }) => {
          if (chunk.type === "raw") {
            const raw = chunk.rawValue as { type?: string; response?: { id?: string } };
            if (raw?.type === "response.created" && raw.response?.id) {
              this.stash({ responseId: raw.response.id });
            }
          }
        }
      });
      return result.toUIMessageStreamResponse();
    }

    // ... other providers
  }
}
```

### `continueLastTurn()`

Called automatically by the default recovery path (or manually). It:

1. Finds the last assistant message in `this.messages`
2. Re-calls `onChatMessage` with the saved `_lastBody` and `_lastClientTools`
3. Streams the response as a **continuation** — appended to the existing assistant message, not a new one
4. No synthetic user message is created

This produces a seamless experience for the user — the interrupted message just keeps growing from where it stopped.

## Interaction with hibernation

Durable Objects can be hibernated — evicted from memory while keeping `ctx.storage` (SQLite) intact. On wake, the constructor re-runs.

Key behaviors during hibernation:

- **`cf_agents_runs` rows persist** — SQLite survives hibernation
- **`_runFiberActiveFibers` (in-memory Set) is empty** — reconstructed from scratch
- **`_checkRunFibers()` runs eagerly in `onStart()` on first wake** — any row NOT in the (empty) in-memory set is treated as interrupted. The alarm path also calls it as a fallback, with a re-entrancy guard preventing double recovery
- **`_lastBody` and `_lastClientTools` are restored from SQLite** — `cf_ai_chat_request_context` table, restored in the constructor

The `cf_agents_runs` table is created with `CREATE TABLE IF NOT EXISTS` in the Agent constructor — cheap DDL that runs every wake. No `_fibersTableCreated` flag needed (that would reset on hibernation and miss recovery).

## Interaction with the alarm system

1. `runFiber()` calls `keepAlive()`, which increments `_keepAliveRefs` and calls `_scheduleNextAlarm()`
2. `_scheduleNextAlarm()` sets `ctx.storage.setAlarm(now + keepAliveIntervalMs)` — persists to disk
3. On wake, `onStart()` calls `_checkRunFibers()` eagerly — recovery fires immediately on the first request
4. The alarm also calls `_onAlarmHousekeeping()` → `_checkRunFibers()` as a fallback (re-entrancy guard prevents double recovery)
5. `_scheduleNextAlarm()` sets the next alarm if refs are still held

The alarm handler itself runs for milliseconds (a few SQL queries + setting the next alarm). The actual fiber work runs in the method execution context, not the alarm handler. The 15-minute alarm timeout is a non-issue.

## Local development

Workerd persists both SQLite and alarm state to disk. Local development and production behave identically for fiber recovery:

1. Fiber is running, `keepAlive()` sets an alarm
2. Process is killed (SIGKILL, code update, `Ctrl-C`)
3. Process restarts — first request triggers `onStart()` → `_checkRunFibers()` → recovery
4. Persisted alarm also fires as fallback → `_onAlarmHousekeeping()` → `_checkRunFibers()` (no-op, already recovered)

The E2E test in `packages/agents/src/e2e-tests/` validates this: it starts wrangler, spawns a fiber, kills the process with SIGKILL, restarts with the same persist directory, and verifies the fiber recovers automatically.

## Tradeoffs

### Lambda vs. method name

Lambdas can't be serialized — on recovery, the original function is gone. Recovery uses the `name` + `snapshot`, not the function. The developer must implement `onFiberRecovered` to re-invoke work from checkpoint data. This is explicit and gives full control, but requires more code than the old "re-invoke the method with original payload" default.

### Inline vs. fire-and-forget

`runFiber()` supports both patterns:

```typescript
// Inline — await the result
const result = await this.runFiber("work", async (ctx) => {
  return computeExpensiveThing();
});

// Fire-and-forget — caller doesn't wait
void this.runFiber("background", async (ctx) => {
  await longRunningProcess();
});
```

If the DO is evicted during an inline `await`, the caller is gone. On recovery, `onFiberRecovered` fires — it has no way to return a result to the original caller. This is the inherent limitation of durable execution across process boundaries.

### No automatic retries

The old API had `maxRetries` with automatic retry loops. In practice, blind retries are rarely the right strategy — the developer needs context about what failed. `onFiberRecovered` gives them the snapshot and lets them decide: retry, skip, alert the user, or do something provider-specific.

### Minimal schema

`cf_agents_runs` has 4 columns. Rows exist only while fibers are running. No status tracking, no retry counts, no completion timestamps. This is intentional — the old 12-column schema stored data the framework never used. Recovery logic belongs in the developer's hook, not in framework-managed status fields.

### Per-fiber snapshots vs. shared state

Each fiber's snapshot is stored in its own row in `cf_agents_runs`, separate from `agent.state`. This is intentional — fibers are independent units of work, and their checkpoints shouldn't interfere with each other or with client-visible shared state.
