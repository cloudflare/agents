# `onContextStart` / `onContextEnd` API

> Extensible per-entry-point context for tracing, auth, and observability.

## Problem

The SDK wraps lifecycle entry points with an internal `AsyncLocalStorage` but the store shape is fixed. Users who need tracing, OTel, auth context, etc. must:

1. Create a **second** `AsyncLocalStorage`
2. Manually `.run()` it in every lifecycle hook
3. Hope they didn't miss an entry point
4. Deal with two parallel ALS stores

The SDK already does the hard work of wrapping every entry point. Users should piggyback on that.

## Design

### User-facing API

```typescript
class Agent<Env, State, Props> {
  /** Override to provide per-entry-point context. */
  onContextStart(input: AgentContextInput): unknown | Promise<unknown>;

  /** Override to clean up context resources (spans, timers). Called in finally. */
  onContextEnd?(
    context: Awaited<ReturnType<this["onContextStart"]>>,
    input: AgentContextInput
  ): void | Promise<void>;

  /** Current context. Typed per-class via onContextStart return type. */
  get context(): Awaited<ReturnType<this["onContextStart"]>> | undefined;

  /** Run fn with context created from input. For custom entry points. */
  withContext<R>(
    input: AgentContextInput,
    fn: () => R | Promise<R>
  ): Promise<R>;
}

/** Read context from any async scope (external utilities). Untyped. */
export function getCurrentContext(): unknown;

/** Existing — gains `context` field. */
export function getCurrentAgent<T extends Agent>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
  context: Awaited<ReturnType<T["onContextStart"]>> | undefined;
};
```

### `AgentContextInput` discriminated union

```typescript
export type AgentContextInput =
  | {
      lifecycle: "start";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: undefined;
    }
  | {
      lifecycle: "request";
      agent: Agent;
      request: Request;
      connection: undefined;
      email: undefined;
    }
  | {
      lifecycle: "connect";
      agent: Agent;
      request: Request;
      connection: Connection;
      email: undefined;
    }
  | {
      lifecycle: "message";
      agent: Agent;
      request: undefined;
      connection: Connection;
      email: undefined;
    }
  | {
      lifecycle: "close";
      agent: Agent;
      request: undefined;
      connection: Connection;
      email: undefined;
    }
  | {
      lifecycle: "email";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: AgentEmail;
    }
  | {
      lifecycle: "schedule";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: undefined;
      callback: string;
    }
  | {
      lifecycle: "queue";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: undefined;
      callback: string;
    }
  | {
      lifecycle: "alarm";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: undefined;
    }
  | {
      lifecycle: "method";
      agent: Agent;
      request: undefined;
      connection: undefined;
      email: undefined;
    };
```

### Usage

```typescript
import { Agent, getCurrentContext, type AgentContextInput } from "agents";

export class TracedAgent extends Agent<Env, MyState> {
  onContextStart(input: AgentContextInput) {
    const span = tracer.startSpan(`agent.${input.lifecycle}`);
    return { span, traceId: span.spanContext().traceId };
  }

  onContextEnd(ctx: { span: Span; traceId: string }) {
    ctx.span.end();
  }

  async onMessage(conn: Connection, msg: string | ArrayBufferLike) {
    // this.context is typed as { span: Span; traceId: string } | undefined
    console.log(this.context?.traceId);
    await this.doWork();
  }

  async doWork() {
    // Inherited — same traceId, no re-creation
    console.log(this.context?.traceId);
  }
}

// External utility — works via ALS propagation
function log(msg: string) {
  const ctx = getCurrentContext() as { traceId: string } | undefined;
  console.log(`[${ctx?.traceId}] ${msg}`);
}
```

## Typing Strategy

**Per-class inference via `ReturnType<this["onContextStart"]>`** — no 4th generic parameter, no global pollution.

- `this.context` on a subclass is typed from that class's `onContextStart` return type
- `getCurrentContext()` returns `unknown` (caller narrows)
- `getCurrentAgent<MyAgent>().context` returns the typed context
- Module augmentation available as opt-in escape hatch for `getCurrentContext()` in external code

```typescript
// Optional: augment for external code
declare module "agents" {
  interface AgentRuntimeContext {
    traceId: string;
  }
}
```

## Internal Rules

### Create vs Inherit

| Situation                                                                        | Action                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Entry point (onRequest, onMessage, onConnect, onStart, onEmail, schedule, alarm) | **Create**: call `onContextStart`, store result in ALS     |
| Custom method called from within a lifecycle hook                                | **Inherit**: ALS store already exists, pass through        |
| Custom method called with no parent ALS                                          | **Create**: call `onContextStart({ lifecycle: "method" })` |
| `_flushQueue` callback with existing parent store                                | **Inherit**: queue flush is a continuation                 |
| `_flushQueue` callback with no parent store                                      | **Create**: `{ lifecycle: "queue", callback }`             |
| State change notification                                                        | **Inherit**: always inherits parent context                |

### Entry Point Wrapping Pattern

Every `agentContext.run()` call site changes to:

```typescript
const input: AgentContextInput = {
  lifecycle: "request",
  agent: this,
  request,
  connection: undefined,
  email: undefined
};
const userCtx = await this._resolveContext(input);
return agentContext.run(
  {
    agent: this,
    connection: undefined,
    request,
    email: undefined,
    context: userCtx
  },
  async () => {
    try {
      return await handler();
    } finally {
      if (this.onContextEnd && userCtx != null) {
        await this.onContextEnd(userCtx, input);
      }
    }
  }
);
```

### `withAgentContext` (auto-wrapped custom methods)

```
if store exists with agent === this → INHERIT (no onContextStart call)
if no store → call onContextStart({ lifecycle: "method", ... })
  - sync path: if onContextStart returns Promise, warn and use undefined
  - this only triggers for methods called completely outside any lifecycle
```

### Async Support

`onContextStart` may return a value or a Promise. Internal helper:

```typescript
private async _resolveContext(input: AgentContextInput): Promise<unknown> {
  const result = this.onContextStart(input);
  return result instanceof Promise ? await result : result;
}
```

For the sync `withAgentContext` wrapper, only sync return values are supported. Async `onContextStart` in this path logs a warning and falls back to `undefined`.

## Branch Scope

- No migration shims or aliases required on this branch
- Hook names are updated directly to `onContextStart` / `onContextEnd`
- `AgentContextStore` carries `context: unknown`

## Files Changed

| File                                      | Change                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agents/src/internal_context.ts` | Add `AgentRuntimeContext` interface, `context` field to `AgentContextStore`                                                                                               |
| `packages/agents/src/index.ts`            | `onContextStart`, `onContextEnd`, `context` getter, `withContext`, `getCurrentContext`, `_resolveContext`, update 9 `agentContext.run()` sites, update `withAgentContext` |
| `packages/agents/src/types.ts`            | `AgentContextInput` type (or inline in index.ts)                                                                                                                          |

## Call Sites to Update

| Location (approx line) | Entry point               | `lifecycle` value                                          |
| ---------------------- | ------------------------- | ---------------------------------------------------------- |
| ~898                   | `onRequest` wrapper       | `"request"`                                                |
| ~919                   | `onMessage` wrapper       | `"message"`                                                |
| ~1064                  | `onConnect` wrapper       | `"connect"`                                                |
| ~1100                  | `onClose` wrapper         | `"close"`                                                  |
| ~1127                  | `onStart` wrapper         | `"start"`                                                  |
| ~1562                  | `_onEmail`                | `"email"`                                                  |
| ~2365                  | schedule execution        | `"schedule"` (+ `callback: row.callback`)                  |
| ~2320                  | `alarm`                   | `"alarm"`                                                  |
| ~1857                  | `_flushQueue`             | **inherit** if parent store, else `"queue"` (+ `callback`) |
| ~1249                  | state change notification | **inherit** (always)                                       |
| ~527                   | `withAgentContext`        | `"method"` (only when no parent store)                     |

## Test Plan

### Test Agents (new file: `packages/agents/src/tests/agents/context.ts`)

| Agent                      | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `TestContextAgent`         | Full onContextStart + onContextEnd; logs every call; exposes via RPC/HTTP |
| `TestNoContextAgent`       | No onContextStart override — backwards compat                             |
| `TestAsyncContextAgent`    | Async onContextStart (simulates KV/JWT lookup)                            |
| `TestThrowingContextAgent` | onContextStart that throws on demand — fail-fast                          |
| `TestContextScheduleAgent` | Schedule callback context verification                                    |

### Test Groups (new file: `packages/agents/src/tests/context.test.ts`)

**Group 1: onContextStart invocation** — verify called with correct lifecycle at each entry point (request, connect, message, start).

**Group 2: Context inheritance** — verify custom methods inherit parent context; verify onContextStart NOT re-called for inherited methods.

**Group 3: getCurrentContext()** — verify accessible from external utility functions.

**Group 4: onContextEnd** — verify called after onRequest, onMessage; verify matching traceId; verify called even on handler error.

**Group 5: Backwards compatibility** — verify agents without onContextStart work unchanged; this.context is undefined.

**Group 6: Async onContextStart** — verify async onContextStart resolves before handler runs.

**Group 7: Error handling** — verify onContextStart throw prevents handler execution (fail fast, 500 response).

### Type Tests (new file: `packages/agents/src/tests/context-types.test.ts`)

Compile-time only via `expectTypeOf`:

- `this.context` infers from `onContextStart` return type
- `this.context` is `unknown | undefined` when no override
- `getCurrentContext()` returns `unknown`
- `getCurrentAgent<T>().context` matches T's onContextStart

## Ecosystem Precedent

| Framework     | Pattern                                          | How context typed     | Cleanup               |
| ------------- | ------------------------------------------------ | --------------------- | --------------------- |
| **tRPC**      | `createContext()` → generic inference            | Generic inference     | No                    |
| **Hono**      | `ContextVariableMap` module augmentation         | Module augmentation   | No                    |
| **Fastify**   | `decorateRequest` + module augmentation          | Module augmentation   | `onRequestAbort`      |
| **Elysia**    | Generic `Context<...>` with store/derive/resolve | Generic type params   | `onAfterHandle`       |
| **OTel JS**   | `context.with(ctx, fn)` + `context.active()`     | Symbol-keyed bag      | Manual `span.end()`   |
| **Sentry CF** | `AsyncLocalStorage.run()` + `withScope()`        | Internal typed scopes | `finish()` in finally |

This design follows tRPC's `createContext` pattern for the hook, OTel's `context.with` for `withContext`, and Fastify's `onRequestAbort` precedent for `onContextEnd`.

## Resolved Design Questions

**Q: Should `_flushQueue` / state-change inherit parent context?**
Yes. They are continuations, not independent entry points. Matches OTel `context.with()` semantics.

**Q: Should `withContext` be public?**
Yes. Needed for webhook handlers, custom WS upgrades, testing.

**Q: Should `context` appear on `getCurrentAgent()`?**
Yes. Both `getCurrentAgent().context` and `getCurrentContext()`.

**Q: Does OTel need a cleanup hook?**
Yes. `onContextEnd` runs in `finally` whenever `onContextStart` produced a non-nullish context value. Separate from `onContextStart` (no `Disposable` coupling).

**Q: Module augmentation vs generic?**
Return-type inference primary. Module augmentation opt-in for `getCurrentContext()` typing.

**Q: Sync or async `onContextStart`?**
Allow async. Sync fast path in `withAgentContext` (auto-wrapped methods).
