# Loopback Pattern

Cross-boundary RPC for sub-agents and dynamic isolates.

## The problem

Sub-agents (facets) run as colocated child Durable Objects with their own isolated SQLite. The parent calls them via typed RPC stubs. But several things cannot cross the RPC boundary:

- **`AbortSignal`** — not serializable without the `AbortSignal serialization` compat flag. Passing one from parent to sub-agent throws `DataCloneError`.
- **Closures and live objects** — an `RpcTarget` can cross the boundary, but it ties the child's execution to a live reference held by the parent. If the parent hibernates, the reference dies.
- **Dynamic worker bindings** — dynamic isolates loaded via `env.LOADER` can only receive `Fetcher`/`ServiceStub` in their `env`, not `RpcStub`. You cannot hand them an RPC handle to a Durable Object.
- **Persistable references** — a stub to a dynamic worker entrypoint cannot be persisted, because the system doesn't know how to restart the dynamic worker without help from whatever loaded it.

These constraints show up in practice whenever a sub-agent needs to call back to the parent (or siblings), or when a dynamically loaded worker needs to interact with the agent that spawned it.

## The pattern

A **loopback** is a `WorkerEntrypoint` subclass that carries serializable props identifying a target, and resolves the actual target at call time via `ctx.exports`.

```typescript
type LoopbackProps = {
  agentId: string;
  resourceId: number;
};

export class MyLoopback extends WorkerEntrypoint<Env, LoopbackProps> {
  constructor(ctx: ExecutionContext<LoopbackProps>, env: Env) {
    super(ctx, env);

    // Resolve the target DO from ctx.exports using the serializable props
    let ns = ctx.exports.MyAgent;
    let stub = ns.get(ns.idFromString(ctx.props.agentId));

    // Get the actual RPC target
    let session = stub.getResource(ctx.props.resourceId);

    // Return a Proxy so callers see the loopback as the real thing
    return new Proxy(session, {
      get(target, prop, receiver) {
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf() {
        return WorkerEntrypoint.prototype;
      }
    });
  }

  // Workaround: at least one method must be declared or the runtime
  // validator won't register the class and the binding won't be created.
  _dummy() {}
}
```

Created via:

```typescript
let loopback = ctx.exports.MyLoopback({ props: { agentId, resourceId } });
```

This produces a `Fetcher` — the one type that can go into a dynamic isolate's `env`, be persisted by a gatekeeper, or be passed anywhere a service binding is accepted.

### Why it works

1. **Props are plain data** — `agentId` and `resourceId` are strings/numbers, fully serializable and persistable.
2. **Resolution happens at call time** — the constructor runs when someone invokes a method on the loopback. `ctx.exports` gives access to all DO namespaces in the same worker, so the loopback can find its target without holding a live reference.
3. **The Proxy is transparent** — callers interact with the loopback as if it were the real target. The `getPrototypeOf` override makes it pass `instanceof` checks against `WorkerEntrypoint`.
4. **Survives hibernation** — since there's no live reference to preserve, only serializable props, the loopback can be stored and re-resolved after the parent wakes.

## Variations

The pattern has several shapes depending on the direction of the call:

### Parent-to-child binding (env injection)

Place loopbacks in a dynamic isolate's `env` so it can call back to parent-managed resources:

```typescript
// In the parent agent, when loading a dynamic worker:
let env = {
  MY_RESOURCE: ctx.exports.ResourceLoopback({
    props: { agentId: this.ctx.id.toString(), resourceId: 42 }
  })
};
return { mainModule: "worker.js", modules, env };
```

The dynamic worker sees `env.MY_RESOURCE` as a normal service binding and calls methods on it. Each call triggers the loopback constructor, which resolves the parent DO and delegates.

### Child-to-parent callback (hook delivery)

When a child resource needs to call a hook exported by a dynamic worker, but the child can't hold a direct stub (not persistable), a loopback in the reverse direction works:

```typescript
// The parent stores a loopback Fetcher on the child instead of a direct stub
let hookLoopback = ctx.exports.HookLoopback({
  props: { agentId: this.ctx.id.toString(), hookName: "onUpdate" }
});
await child.setHook(hookLoopback);
```

The child calls the hook via the loopback. The loopback resolves the parent, which loads the dynamic worker and finds the hook entrypoint.

### Tail worker delivery (log forwarding)

Attach a loopback as a tail worker to a dynamic isolate to forward `console.log` output and exceptions back to the parent:

```typescript
return {
  mainModule: "worker.js",
  modules,
  tails: [
    ctx.exports.TailLoopback({
      props: { agentId: this.ctx.id.toString(), contextId: chatId }
    })
  ]
};
```

The tail loopback receives `TraceItem` events and delivers them to the parent via `ctx.exports`.

## Relevance to the Agents SDK

### Current state: ToolBridge / RpcTarget

In the assistant example, the parent passes an `RpcTarget` (ToolBridge) to the sub-agent on each `chatWithBridge()` call. This works but has limitations:

- The bridge is per-call — it must be passed as an argument every time
- `AbortSignal` cannot be passed alongside it (DataCloneError)
- If the parent hibernates while the sub-agent is mid-call, the RpcTarget reference dies
- The sub-agent cannot initiate calls back to the parent unprompted

### Future direction: loopback bindings for sub-agents

The loopback pattern could replace per-call RpcTarget passing with persistent, self-resolving bindings:

```typescript
// Parent configures the sub-agent with loopback bindings at creation time
const session = await this.subAgent(ChatSession, "session-1", {
  bindings: {
    SHARED_WORKSPACE: ctx.exports.WorkspaceLoopback({
      props: { agentId: this.ctx.id.toString() }
    }),
    ABORT: ctx.exports.AbortLoopback({
      props: { agentId: this.ctx.id.toString(), requestId }
    })
  }
});
```

The sub-agent accesses these as `env.SHARED_WORKSPACE` — no need to pass them per-call. The abort loopback could expose a `poll()` method the sub-agent checks periodically, sidestepping the AbortSignal serialization issue entirely.

This is speculative and depends on facets supporting custom env injection, which they do not today. But it's the direction the pattern points toward.

## Tradeoffs

- **Indirection cost** — every call through a loopback resolves the target DO from scratch. For facets (colocated children) this is cheap. For cross-worker calls it involves a network hop.
- **No type safety at the boundary** — the Proxy returns `any`. The caller doesn't get TypeScript type checking on the methods. This could be improved with a typed wrapper.
- **Constructor-return Proxy is unusual** — returning a Proxy from a constructor is a valid but surprising JavaScript pattern. It may confuse contributors unfamiliar with the codebase.
- **Runtime workarounds** — several `getOwnPropertyDescriptor` and `getPrototypeOf` overrides exist to work around workerd bugs. These should be removable as the runtime matures.

## Origin

This pattern was developed in the [Gadgets Workshop](https://github.com/nicholasblaskey/minions) backend (`packages/workshop-backend/src/overseer.ts`) where it is used extensively:

- `GatekeeperLoopback` — injects gatekeeper session bindings into dynamic gadget workers
- `GatekeeperHookLoopback` — allows gatekeepers to call hooks exported by dynamic gadget workers
- `GadgetTailLoopback` — forwards console logs from dynamic gadgets back to the overseer
- `CodeModeTailLoopback` — forwards execution traces from one-shot code runs back to the overseer
