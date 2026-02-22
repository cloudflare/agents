# Retries

This document describes the retry system in the Agents SDK: how it works, where it is used, the key decisions made, and alternatives considered.

## Problem

Agents interact with external services and Cloudflare platform APIs that can fail transiently: Durable Object RPCs, Workflow operations, MCP server connections, and user-defined callbacks in queues and schedules. Without structured retries, every failure is either fatal or requires developers to hand-roll retry logic with inconsistent patterns.

The `cloudflare/actors` library includes well-tested retry primitives (`tryN`, `jitterBackoff`, `isErrorRetryable`). We wanted to bring similar reliability to the Agents SDK while keeping the API surface small and the implementation internal until the patterns prove out.

## Design goals

1. **Internal first** — the retry primitives (`tryN`, `jitterBackoff`, `isErrorRetryable`, `validateRetryOptions`) live in `src/retries.ts` and are not re-exported from the package entry point. Only the `RetryOptions` type is re-exported for TypeScript consumers. The primitives are implementation details that can change without a breaking change.
2. **Public `this.retry()`** — a single user-facing method on the `Agent` class for ad-hoc retry logic. Thin wrapper over the internals.
3. **Per-call-site configurability** — `schedule()`, `scheduleEvery()`, and `queue()` accept an optional `{ retry?: RetryOptions }` parameter so developers can tune retry behavior per task.
4. **Backward compatible** — all new parameters are optional. Existing code works unchanged. Schema migrations use `ADD COLUMN IF NOT EXISTS` pattern.
5. **Sensible defaults** — 3 attempts, 100ms base delay, jittered exponential backoff. No configuration needed for the common case.
6. **Class-level defaults** — override defaults for an entire agent via `static options = { retry: { ... } }`, following the existing pattern for `hibernate`, `sendIdentityOnConnect`, etc.

## Architecture

### Core primitives (`src/retries.ts`)

Three functions, one type:

| Export                                            | Purpose                                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetryOptions`                                    | Interface: `{ maxAttempts?, baseDelayMs?, maxDelayMs? }`                                                                                                                                                        |
| `jitterBackoff(attempt, baseDelayMs, maxDelayMs)` | Full Jitter backoff per [AWS blog post](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). Returns `random(0, min(2^attempt * base, max))`.                                            |
| `tryN(n, fn, options?)`                           | Retry `fn` up to `n` total attempts. Accepts optional `shouldRetry` predicate to bail early on non-retryable errors.                                                                                            |
| `validateRetryOptions(options, defaults?)`        | Eagerly validate retry config. When `defaults` are provided, resolves partial options against them before cross-field checks.                                                                                   |
| `isErrorRetryable(err)`                           | Returns `true` if the error has `retryable: true` but is not an overloaded Durable Object error. Follows [CF best practices](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/). |

`tryN` is the only retry loop. Everything else composes on top of it.

### Input validation

Validation is designed to fail fast and fail clearly:

- **`validateRetryOptions(options, defaults?)`** runs at enqueue/schedule/`this.retry()` time. It checks individual field ranges, enforces integer `maxAttempts`, and validates cross-field constraints (`baseDelayMs <= maxDelayMs`) after resolving against defaults. This means `{ baseDelayMs: 5000 }` against default `maxDelayMs: 3000` throws immediately instead of failing minutes later at execution time.
- **`tryN` also validates** its inputs with `Number.isFinite()` checks — guarding against `NaN` and `Infinity` that could produce zero-delay retries. Error messages are consistent between both validation paths (e.g. "retry.maxAttempts must be >= 1").

### Public API

**`this.retry(fn, options?)`** on the `Agent` class. Retries all errors by default. Accepts an optional `shouldRetry` predicate to bail early on non-retryable errors. The predicate signature is `(err: unknown, nextAttempt: number) => boolean` — the `nextAttempt` parameter enables attempt-aware retry decisions (e.g. "retry rate-limit errors up to 3 times but only once for everything else"). The predicate is defined as an intersection with `RetryOptions` rather than a separate type — this keeps the type surface minimal while making `shouldRetry` unavailable on `queue()`/`schedule()` via IDE autocomplete (since those accept plain `RetryOptions`).

**`RetryOptions`** type is re-exported from the package for TypeScript consumers who want to type their options objects.

**`{ retry?: RetryOptions }`** parameter on `queue()`, `schedule()`, and `scheduleEvery()`. Stored as JSON in a `retry_options TEXT` column. Read back at execution time and passed to `tryN`. Retry options are **validated eagerly** at enqueue/schedule time via `validateRetryOptions()` with class-level defaults as the second argument — invalid values like `maxAttempts: 0`, `baseDelayMs: -1`, or `baseDelayMs` exceeding the resolved `maxDelayMs` all throw immediately.

### Integration points

| Location                    | What is retried             | `shouldRetry`      | Defaults                        |
| --------------------------- | --------------------------- | ------------------ | ------------------------------- |
| `_flushQueue()`             | Queue callback execution    | All errors         | 3 attempts, 100ms base, 3s max  |
| Schedule alarm handler      | Schedule callback execution | All errors         | 3 attempts, 100ms base, 3s max  |
| `terminateWorkflow()`       | `instance.terminate()`      | `isErrorRetryable` | 3 attempts, 200ms base, 3s max  |
| `pauseWorkflow()`           | `instance.pause()`          | `isErrorRetryable` | 3 attempts, 200ms base, 3s max  |
| `resumeWorkflow()`          | `instance.resume()`         | `isErrorRetryable` | 3 attempts, 200ms base, 3s max  |
| `restartWorkflow()`         | `instance.restart()`        | `isErrorRetryable` | 3 attempts, 200ms base, 3s max  |
| `sendEventToWorkflow()`     | `instance.sendEvent()`      | `isErrorRetryable` | 3 attempts, 200ms base, 3s max  |
| MCP `_restoreServer()`      | Server reconnection         | All errors         | Per-server config or 3/500ms/5s |
| MCP `establishConnection()` | Post-OAuth connection       | All errors         | Per-server config or 3/500ms/5s |

Workflow operations use `isErrorRetryable` because they are DO RPC calls where we can distinguish transient errors from permanent failures. Queue/schedule callbacks and MCP connections retry all errors because the failure modes are broader and user-defined.

MCP retry config is stored in the `server_options` JSON column alongside `client` and `transport` options, so it persists across hibernation. Developers configure it via `addMcpServer(name, url, { retry: { ... } })` or `registerServer(id, { ..., retry: { ... } })`.

### Observability

Queue and schedule retry attempts emit observability events:

- `queue:retry` — emitted before each retry attempt in `_flushQueue()`, with `callback`, `id`, `attempt`, and `maxAttempts` in the payload.
- `schedule:retry` — emitted before each retry attempt in the schedule alarm handler, with the same payload shape.

These events are only emitted for attempts > 1 (the first attempt is not a "retry"). They use the existing `this.observability?.emit()` pattern, so they appear in the observability stream alongside `schedule:execute` and other events. This enables users to monitor retry behavior in dashboards and logs.

### Performance

`_resolvedOptions` is cached after first access. Static options never change during the lifetime of a DO instance, so the resolved options object is computed once and reused. This avoids allocating a new object on every call to `_flushQueue`, schedule alarm handler, or `this.retry()`.

Retry option parsing from SQLite rows uses a shared `parseRetryOptions()` helper and a `resolveRetryConfig()` helper to merge per-task options with class-level defaults. These are used by both `_flushQueue` and the schedule alarm handler, eliminating duplicated parsing logic.

## Key decisions

### Why full jitter, not equal jitter or decorrelated jitter?

Full jitter (`random(0, cap)`) has the best p99 latency characteristics for high-contention scenarios according to the [AWS analysis](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). The implementation is also the simplest — a single `Math.random()` call.

### Why `shouldRetry` instead of retrying everything?

Durable Object overload errors (`retryable: true` + `overloaded: true`) should not be retried — they indicate the DO is rejecting work to protect itself. Retrying would make congestion worse. For workflow operations, we use `isErrorRetryable` to respect this. For user callbacks and MCP connections, we retry all errors because we cannot know what kind of error the user's code will throw.

The internal `TryNOptions.shouldRetry` and the public `this.retry()`'s `shouldRetry` use the same name and compatible signatures: `(err: unknown, nextAttempt: number) => boolean`. The `nextAttempt` parameter allows attempt-aware decisions. Functions that only care about the error (like `isErrorRetryable`) work as-is — extra arguments are ignored.

### Why store retry options in the DB instead of in memory?

Schedules and queues survive agent restarts (hibernation). If retry options were in memory, they would be lost when the DO hibernates and wakes up. Storing them as JSON in a `retry_options TEXT` column ensures they persist alongside the task.

### Class-level default retry config

Retry defaults are part of the existing `static options` pattern on the Agent class:

```typescript
class MyAgent extends Agent {
  static options = {
    retry: { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 5000 }
  };
}
```

This was added to `DEFAULT_AGENT_STATIC_OPTIONS` alongside `hibernate`, `sendIdentityOnConnect`, and `hungScheduleTimeoutSeconds`. The `_resolvedOptions` getter merges the user's partial overrides with built-in defaults and caches the result, so `{ retry: { maxAttempts: 10 } }` only overrides `maxAttempts` while keeping `baseDelayMs` and `maxDelayMs` at their defaults.

The type system enforces this correctly: `AgentStaticOptions.retry` is typed as `RetryOptions` (all fields optional), while `ResolvedAgentOptions.retry` is `Required<RetryOptions>` (all fields required, filled from defaults). Per-call-site options always take priority over class-level defaults.

### Why `this.retry()` retries all errors by default?

The method is designed for user code — calling external APIs, fetching data, sending notifications. These operations fail with generic `Error` objects or network errors that do not have a `retryable` property. Requiring a `shouldRetry` predicate would add friction for the 90% case.

For the 10% case where selective retry is needed, `this.retry()` accepts an optional `shouldRetry` predicate:

```typescript
await this.retry(
  async () => {
    const res = await fetch(url);
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  {
    shouldRetry: (err, nextAttempt) => {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        return false; // 4xx: don't retry
      }
      return true; // 5xx, network errors: retry
    }
  }
);
```

`shouldRetry` is only available on `this.retry()`, not on `schedule()`/`queue()`, because functions cannot be serialized to SQLite. For scheduled/queued tasks, handle non-retryable errors inside the callback.

### Why not adopt `tryWhile` from cloudflare/actors?

The actors library has a `tryWhile(condition, fn)` that retries as long as a condition function returns true. We dropped it because:

1. `tryN` with `shouldRetry` covers the same use case more safely (bounded attempts)
2. `tryWhile` with a bug in the condition function retries forever
3. Internal-only usage does not need the flexibility

## Schema migration

Two columns added via `ALTER TABLE ... ADD COLUMN`:

- `cf_agents_schedules.retry_options TEXT` — JSON-serialized `RetryOptions`
- `cf_agents_queues.retry_options TEXT` — JSON-serialized `RetryOptions`

Both use the `addColumnIfNotExists` pattern already established for `intervalSeconds`, `running`, and `execution_started_at`. The migration runs in the Agent constructor alongside existing migrations.

## Tradeoffs

**Queue callbacks still dequeue on failure.** After all retry attempts are exhausted, the task is dequeued. We do not have a dead-letter queue. If a task fails permanently, it is logged and routed through `onError()`, but the item is removed. This matches the existing behavior (before retries, tasks were dequeued immediately after one attempt). A dead-letter mechanism could be added later.

**No circuit breaker.** If an external service is down, retry attempts will consume wall-clock time (up to `maxAttempts * maxDelayMs`). For queue and schedule execution, this delays subsequent tasks. A circuit breaker pattern could short-circuit retries after repeated failures, but adds significant complexity. Deferred for now.

**Retry delays block the event loop.** `tryN` uses `setTimeout` between attempts. During this time, the DO is awake but idle. For short delays (100ms–3s) this is acceptable. For longer delays, consider using `schedule()` to retry at a future time instead of blocking. Queue retries are head-of-line blocking — one failing item's retries delay all subsequent items. If independent retry is needed, use `this.retry()` inside the callback instead of per-task retry options.

## Testing

Unit tests in `packages/agents/src/tests/retries.test.ts`:

- `jitterBackoff`: value range, increasing upper bound with attempt number
- `tryN`: success on first attempt, success after transient failures, exhaust attempts, `shouldRetry` bail-out, `shouldRetry` receives nextAttempt, attempt number passed to fn, invalid inputs (zero, NaN, Infinity), fractional n floors to integer, n=1 behavior
- `validateRetryOptions`: valid options, maxAttempts < 1, non-integer maxAttempts, non-finite maxAttempts, baseDelayMs/maxDelayMs <= 0, cross-field baseDelayMs > maxDelayMs, single-field without defaults, resolution against defaults
- `isErrorRetryable`: retryable non-overloaded errors, non-retryable errors, overloaded message variants, overloaded property, non-object errors

Integration tests in `packages/agents/src/tests/retry-integration.test.ts`:

- `this.retry()`: succeed on first attempt, succeed after transient failures, exhaust retries
- `shouldRetry`: transient errors succeed, permanent errors bail early, receives next attempt number
- `queue()` with retry: retries and succeeds, persists retry options on single items, persists retry options on multiple items via `getQueues`
- `schedule()` with retry: retries and succeeds, persists retry options
- Eager validation: rejects invalid options on queue/schedule, rejects cross-field invalid options resolved against defaults, rejects fractional maxAttempts
- Class-level defaults: uses class-level maxAttempts, exhausts after class-level maxAttempts, per-call override
