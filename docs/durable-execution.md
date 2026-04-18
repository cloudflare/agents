# Durable Execution

Run work that survives Durable Object eviction. `runFiber()` registers a task in SQLite, keeps the agent alive during execution, lets you checkpoint intermediate state with `stash()`, and calls `onFiberRecovered()` on the next activation if the agent was evicted mid-task.

> For how fibers fit into the bigger picture of building agents that run for weeks or months, see [Long-Running Agents](./long-running-agents.md).

## Quick start

```typescript
import { Agent } from "agents";
import type { FiberRecoveryContext } from "agents";

class MyAgent extends Agent {
  async doWork() {
    await this.runFiber("my-task", async (ctx) => {
      const step1 = await expensiveOperation();
      ctx.stash({ step1 });

      const step2 = await anotherExpensiveOperation(step1);
      this.setState({ ...this.state, result: step2 });
    });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "my-task") return;
    const snapshot = ctx.snapshot as { step1: unknown } | null;
    if (snapshot) {
      // Resume from the checkpoint — step1 is done, run step2
      const step2 = await anotherExpensiveOperation(snapshot.step1);
      this.setState({ ...this.state, result: step2 });
    }
  }
}
```

## Why fibers exist

Durable Objects get evicted for three reasons:

1. **Inactivity timeout** — ~70–140 seconds with no incoming requests or open WebSockets
2. **Code updates / runtime restarts** — non-deterministic, 1–2x per day
3. **Alarm handler timeout** — 15 minutes

When eviction happens mid-work, the upstream HTTP connection (to an LLM provider, an API, a database) is severed permanently. In-memory state — streaming buffers, partial responses, loop counters — is lost. Multi-turn agent loops lose their position entirely.

`keepAlive()` reduces the chance of eviction. `runFiber()` makes eviction survivable.

For work that should run independently of the agent with per-step retries and multi-step orchestration, use [Workflows](./workflows.md) instead. Fibers are for work that is part of the agent's own execution. See [Long-Running Agents: Workflows vs agent-internal patterns](./long-running-agents.md#when-to-use-workflows-vs-agent-internal-patterns) for a comparison.

## `keepAlive()`

Prevents idle eviction by creating a 30-second alarm heartbeat that resets the inactivity timer.

```typescript
class Agent {
  keepAlive(): Promise<() => void>;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
}
```

`keepAliveWhile()` is the recommended approach — it runs an async function and automatically cleans up the heartbeat when it completes or throws:

```typescript
const result = await this.keepAliveWhile(async () => {
  return await slowAPICall();
});
```

For manual control, `keepAlive()` returns a disposer. Always call it when done — otherwise the heartbeat continues indefinitely:

```typescript
const dispose = await this.keepAlive();
try {
  await longWork();
} finally {
  dispose();
}
```

### How it works

While any `keepAlive` ref is held, an alarm fires every 30 seconds that resets the inactivity timer. When all disposers are called, alarms stop and the DO can go idle naturally.

The heartbeat is invisible to `getSchedules()` — no schedule rows are created. It does not conflict with your own schedules; the alarm system multiplexes all schedules and the keepAlive heartbeat through a single alarm slot.

### Configurable interval

Default: 30 seconds. The inactivity timeout is ~70–140 seconds, so 30 seconds gives comfortable margin. Override via static options:

```typescript
class MyAgent extends Agent {
  static options = { keepAliveIntervalMs: 2_000 }; // useful for testing recovery locally
}
```

### When to use keepAlive vs runFiber

`keepAlive` prevents eviction but does nothing about recovery. If the agent _is_ evicted despite the heartbeat (code update, alarm timeout, resource limit), any in-progress work is lost.

`runFiber` calls `keepAlive` internally _and_ persists the work in SQLite so it can be recovered. Use `keepAlive` alone when the work is cheap to redo or does not need checkpointing. Use `runFiber` when the work is expensive and you need to resume from where you left off.

| Scenario                                         | Use                         |
| ------------------------------------------------ | --------------------------- |
| Waiting on a slow API call                       | `keepAlive()`               |
| Streaming an LLM response (via `AIChatAgent`)    | Automatic (built in)        |
| Multi-step computation with intermediate results | `runFiber()`                |
| Background research loop that takes 10+ minutes  | `runFiber()` with `stash()` |

## `runFiber()`

Durable execution with checkpointing and recovery.

```typescript
class Agent {
  runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>;
  stash(data: unknown): void;
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
  createdAt: number;
};
```

### Lifecycle

#### Normal execution

```
runFiber("work", fn)
  ├─ INSERT row into cf_agents_runs
  ├─ keepAlive() — heartbeat starts
  ├─ Execute fn(ctx)
  │    ├─ ctx.stash(data) → UPDATE snapshot in SQLite
  │    ├─ ctx.stash(data) → UPDATE snapshot in SQLite
  │    └─ return result
  ├─ DELETE row from cf_agents_runs
  ├─ keepAlive dispose — heartbeat stops
  └─ Return result to caller
```

#### Eviction and recovery

```
[DO evicted — all in-memory state lost]

  On next activation:
  ├─ Request/connection → onStart() → _checkRunFibers()     [primary path]
  │  OR
  ├─ Persisted alarm fires → _onAlarmHousekeeping()          [fallback path]

  _checkRunFibers():
  ├─ SELECT * FROM cf_agents_runs
  ├─ For each orphaned row:
  │    ├─ Parse snapshot from JSON
  │    ├─ Call onFiberRecovered(ctx)
  │    └─ DELETE the row
  └─ If onFiberRecovered calls runFiber() again → new row, normal execution
```

Both recovery paths call the same hook. The alarm path is critical for background agents that have no incoming client connections — the persisted alarm wakes the agent on its own.

#### Error during execution

```
fn(ctx) throws Error
  ├─ DELETE row from cf_agents_runs
  ├─ keepAlive dispose
  └─ Error propagates to caller (or logged if fire-and-forget)
```

No automatic retries. Recovery logic belongs in `onFiberRecovered`, where you have the snapshot and full context about what went wrong.

### Inline vs fire-and-forget

`runFiber()` supports both patterns:

```typescript
// Inline — await the result
const result = await this.runFiber("work", async (ctx) => {
  return computeExpensiveThing();
});

// Fire-and-forget — caller does not wait
void this.runFiber("background", async (ctx) => {
  await longRunningProcess();
});
```

If the DO is evicted during an inline `await`, the caller is gone. On recovery, `onFiberRecovered` fires — it cannot return a result to the original caller. This is the inherent limitation of durable execution across process boundaries. For long-running work that is likely to outlive a single DO lifetime, fire-and-forget with checkpoint/recovery is the safer pattern.

## Checkpoints with `stash()`

`ctx.stash(data)` writes to SQLite **synchronously**. There is no async gap between "I decided to save" and "it is saved." If eviction happens after `stash()` returns, the data is guaranteed to be in SQLite.

Each call **fully replaces** the previous snapshot — it is not a merge. Write the complete recovery state you need:

```typescript
await this.runFiber("research", async (ctx) => {
  const steps = ["search", "analyze", "synthesize"];
  const completed: string[] = [];
  const results: Record<string, unknown> = {};

  for (const step of steps) {
    results[step] = await executeStep(step);
    completed.push(step);

    ctx.stash({
      completed,
      results,
      pendingSteps: steps.slice(completed.length)
    });
  }
});
```

### `this.stash()` vs `ctx.stash()`

Both do the same thing. `ctx.stash()` uses a direct closure over the fiber ID. `this.stash()` uses `AsyncLocalStorage` to find the currently executing fiber — it works correctly even with concurrent fibers, since each fiber's ALS context is independent.

`this.stash()` is convenient when calling from nested functions that do not have access to `ctx`. It throws if called outside a `runFiber` callback.

## Recovery

Override `onFiberRecovered` to handle interrupted fibers. The default implementation logs a warning and deletes the row.

```typescript
class ResearchAgent extends Agent {
  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "research") return;

    const snapshot = ctx.snapshot as {
      completed: string[];
      results: Record<string, unknown>;
      pendingSteps: string[];
    } | null;

    if (snapshot && snapshot.pendingSteps.length > 0) {
      // Resume from where we left off
      void this.runFiber("research", async (fiberCtx) => {
        const { completed, results, pendingSteps } = snapshot;

        for (const step of pendingSteps) {
          results[step] = await this.executeStep(step);
          completed.push(step);

          fiberCtx.stash({
            completed,
            results,
            pendingSteps: pendingSteps.slice(pendingSteps.indexOf(step) + 1)
          });
        }
      });
    }
  }
}
```

Key points:

- **The original lambda is gone.** On recovery, you only have the `name` and `snapshot`. The lambda cannot be serialized — recovery logic must be in the hook.
- **The row is deleted after the hook runs.** If you want to continue the work, call `runFiber()` again inside the hook — this creates a new row.
- **You control what recovery means.** Retry from the beginning, resume from a checkpoint, skip and notify the user, or do nothing. The framework does not impose a strategy.
- **If the hook throws, the row is still deleted.** You do not get a second chance at recovery. If your recovery logic can fail, catch errors and handle them (e.g., schedule a retry, log, or re-create the fiber).

### Chat recovery

`AIChatAgent` builds on fibers for LLM streaming recovery. When `chatRecovery` is enabled, each chat turn is wrapped in a fiber automatically. The framework handles the internal recovery path and exposes `onChatRecovery` for provider-specific strategies. See [Long-Running Agents: Recovering interrupted LLM streams](./long-running-agents.md#recovering-interrupted-llm-streams) and the [`forever-chat` example](../experimental/forever-chat/).

## Concurrent fibers

Multiple fibers can run at the same time. Each has its own row in SQLite with its own snapshot, and each calls `keepAlive()` independently (ref-counted, so the DO stays alive until all fibers complete).

```typescript
// Run two fibers concurrently
void this.runFiber("fetch-data", async (ctx) => {
  /* ... */
});
void this.runFiber("process-queue", async (ctx) => {
  /* ... */
});
```

On recovery, `_checkRunFibers()` iterates all orphaned rows and calls `onFiberRecovered` for each. Use `ctx.name` to distinguish between fiber types in your recovery hook.

## Testing locally

In `wrangler dev`, fiber recovery works identically to production. SQLite and alarm state persist to disk between restarts.

1. Start your agent and trigger a fiber (`runFiber`)
2. Kill the wrangler process (Ctrl-C or SIGKILL)
3. Restart wrangler
4. Recovery fires automatically — via `onStart()` if a request arrives, or via the persisted alarm if no clients connect

The E2E test in `packages/agents/src/e2e-tests/` validates this: it starts wrangler, spawns a fiber, kills the process with SIGKILL, restarts with the same persist directory, and verifies the fiber recovers automatically.

## API reference

### `runFiber(name, fn)`

Execute a durable fiber. The fiber is registered in SQLite before `fn` runs and deleted after it completes (or throws). `keepAlive()` is held for the duration.

- **`name`** — identifier for the fiber, used in `onFiberRecovered` to distinguish fiber types. Not unique — multiple fibers can share a name.
- **`fn`** — async function receiving a `FiberContext`. Closures work naturally (`this` and local variables are captured).
- **Returns** — the value returned by `fn`. If the DO is evicted before completion, the return value is lost; recovery happens through the hook.

### `stash(data)` / `ctx.stash(data)`

Checkpoint the current fiber's state. Writes synchronously to SQLite. Each call fully replaces the previous snapshot. `data` must be JSON-serializable.

### `onFiberRecovered(ctx)`

Called once per orphaned fiber row on agent restart. Override to implement recovery. The row is deleted after this hook returns.

- **`ctx.id`** — unique fiber ID
- **`ctx.name`** — the name passed to `runFiber()`
- **`ctx.snapshot`** — the last `stash()` data, or `null` if `stash()` was never called
- **`ctx.createdAt`** — epoch milliseconds when `runFiber` started. Compare against `Date.now()` to gate stale recoveries (e.g. skip work that has been orphaned too long to replay safely)

### `keepAlive()`

Create a 30-second alarm heartbeat. Returns a disposer function. Idempotent — calling the disposer multiple times is safe.

### `keepAliveWhile(fn)`

Run an async function while keeping the DO alive. Heartbeat starts before `fn` and stops when it completes or throws. Returns the value returned by `fn`.

## Related

- [Long-Running Agents](./long-running-agents.md) — how fibers compose with schedules, plans, and async operations
- [Scheduling](./scheduling.md) — `keepAlive` details and the alarm system
- [Workflows](./workflows.md) — durable multi-step execution outside the agent
- [Chat Agents](./chat-agents.md) — `chatRecovery` and `onChatRecovery`
- [`forever-chat` example](../experimental/forever-chat/) — multi-provider LLM recovery demo
- [`forever.md` design doc](../experimental/forever.md) — internal design details, tradeoffs, and architecture
