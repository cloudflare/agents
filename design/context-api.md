# `AgentContext` — Proxy-based runtime context

> Declarative per-entry-point context for tracing, auth, and observability.

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
import { Agent, AgentContext, type AgentContextInput } from "agents";

class TracedAgent extends Agent<Env, MyState> {
  context = new AgentContext(this, {
    onStart(input: AgentContextInput) {
      const span = tracer.startSpan(`agent.${input.lifecycle}`);
      return { span, traceId: span.spanContext().traceId };
    },
    onClose(ctx, input) {
      ctx.span.end();
    }
  });

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
```

### Key types

```typescript
// Returned by new AgentContext(agent, hooks) — a Proxy, not an object
interface AgentContextConstructor {
  new <TAgent extends Agent, TValue>(
    agent: TAgent,
    hooks: {
      onStart: (input: AgentContextInput<TAgent>) => TValue | Promise<TValue>;
      onClose?: (
        value: NonNullable<Awaited<TValue>>,
        input: AgentContextInput<TAgent>
      ) => void | Promise<void>;
    }
  ): Awaited<TValue> | undefined;
}

/** Read untyped context from any async scope. */
export function getCurrentContext(): unknown;

/** Read typed context via the agent reference. */
export function getCurrentAgent<T extends Agent>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
  context: T["context"];
};

/** Extract context type from an Agent subclass. */
type AgentContextOf<T extends Agent> = T["context"];
```

### How the Proxy works

`new AgentContext(this, hooks)` does two things:

1. **Stores hooks** in a module-scoped `WeakMap<Agent, AgentContextHooks>` — the hooks object is never visible on the instance.
2. **Returns a Proxy** (via `return new Proxy(...)` in the constructor body) that forwards property access to the current ALS runtime value.

The Proxy traps:
- `get(target, prop)` → reads `agentContext.getStore()?.context[prop]`
- `has(target, prop)` → checks `prop in store.context`
- `ownKeys()` → `Reflect.ownKeys(store.context)` (empty when no ALS)
- `getOwnPropertyDescriptor()` → delegates to `store.context`

Outside any lifecycle scope, all property access returns `undefined`. The Proxy itself is always truthy (it's an object), but has no visible properties.

### Hooks stored in WeakMap

```typescript
interface AgentContextHooks {
  onStart(input: AgentContextInput): unknown;
  onClose?(value: unknown, input: AgentContextInput): unknown;
}

const agentContextHooks = new WeakMap<Agent, AgentContextHooks>();
```

Internal plumbing (`resolveContextForInput`, `runWithContext`, `withAgentContext`) reads from this WeakMap instead of accessing properties on the agent's `context` field.

## Internal Rules

### Create vs Inherit

| Situation                                                                        | Action                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Entry point (onRequest, onMessage, onConnect, onStart, onEmail, schedule, alarm) | **Create**: call `hooks.onStart`, store result in ALS  |
| Custom method called from within a lifecycle hook                                | **Inherit**: ALS store already exists, pass through    |
| Custom method called with no parent ALS                                          | **Create**: call `hooks.onStart({ lifecycle: "method" })` |
| `_flushQueue` callback                                                           | **Create**: `{ lifecycle: "queue", callback }` per item |
| State change notification                                                        | **Inherit**: always inherits parent context              |

### Entry Point Wrapping Pattern

Internal `runWithContext` handles the full lifecycle:

```typescript
async function runWithContext(agent, input, fn) {
  const context = await resolveContextForInput(agent, input);
  return agentContext.run(
    { agent, connection, request, email, context },
    async () => {
      try {
        return await fn();
      } finally {
        const hooks = getAgentContextHooks(agent);
        if (hooks?.onClose && context != null) {
          await hooks.onClose(context, input);
        }
      }
    }
  );
}
```

### `withAgentContext` (auto-wrapped custom methods)

```
if store exists with agent === this → INHERIT (no onStart call)
if no store → call hooks.onStart({ lifecycle: "method", ... })
  - sync path: if onStart returns Promise, warn and use undefined
  - this only triggers for methods called completely outside any lifecycle
```

## Design Evolution

The API went through several iterations:

1. **`onCreateContext`/`onDestroyContext` methods** — hook methods on Agent
2. **`AgentContext.define(this)({})`** — rejected as too clever
3. **`new AgentContext(this, { enter, exit })`** — initial class API
4. **`new AgentContext(this, { onStart, onEnd })`** — renamed hooks
5. **`new AgentContext(this, { onStart, onClose })`** — current, with Proxy

The Proxy approach solved a critical **variance issue**: the earlier `AgentContext<TValue>` interface with callback properties created invariance that broke subclass assignability. The Proxy eliminates this — no generic interface on the instance at all.

## Key Decisions

**Q: Why Proxy instead of a getter?**
The original `get context()` getter read directly from ALS but required complex generic typing (`Awaited<ReturnType<this["onContextStart"]>>`) that created variance problems. The Proxy returns `Awaited<TValue> | undefined` from the constructor signature — TypeScript sees it as a plain value, not a generic interface.

**Q: Why WeakMap for hooks?**
Hooks must be accessible to internal plumbing but invisible to users. A WeakMap keyed by agent instance keeps hooks off the public surface and allows GC when the agent is collected.

**Q: Why `onClose` not `onEnd`?**
Aligns with WebSocket/stream terminology already used in the SDK (`onClose` for connections). "End" is ambiguous (end of what?).

**Q: Why is `AgentContext` not usable as a type?**
It's exported as a `const` (not an interface/class). User code writes `context = new AgentContext(this, {...})` — the field type is inferred from the constructor return type. No need for `context: AgentContext<T> = ...`.

**Q: Why no `currentContext` getter?**
`this.context` IS the runtime value (via Proxy). `getCurrentAgent<T>().context` for external access. One path, not two.

## Files

| File                                      | Role                                                    |
| ----------------------------------------- | ------------------------------------------------------- |
| `packages/agents/src/index.ts`            | AgentContext class, Proxy, WeakMap, internal wrappers    |
| `packages/agents/src/internal_context.ts` | ALS store (`AgentContextStore.context: unknown`)         |
| `packages/agents/src/tests/agents/context.ts` | 5 test agents exercising the API                    |
| `packages/agents/src/tests/context.test.ts` | Runtime tests                                         |
| `packages/agents/src/tests/context-types.test.ts` | Compile-time type tests                          |

## Ecosystem Precedent

| Framework     | Pattern                                          | How context typed     | Cleanup               |
| ------------- | ------------------------------------------------ | --------------------- | --------------------- |
| **tRPC**      | `createContext()` → generic inference            | Generic inference     | No                    |
| **Hono**      | `ContextVariableMap` module augmentation         | Module augmentation   | No                    |
| **Fastify**   | `decorateRequest` + module augmentation          | Module augmentation   | `onRequestAbort`      |
| **OTel JS**   | `context.with(ctx, fn)` + `context.active()`     | Symbol-keyed bag      | Manual `span.end()`   |

This design follows tRPC's `createContext` for the hook pattern, OTel's `context.with` for internal context propagation, and WebSocket `onClose` for the cleanup hook name.
