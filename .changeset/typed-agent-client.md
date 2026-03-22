---
"agents": minor
---

feat: strongly-typed `AgentClient` with `call` inference and `stub` proxy

`AgentClient` now accepts an optional agent type parameter for full type inference on RPC calls, matching the typed experience that `useAgent` already provides.

**New: typed `call` and `stub`**

When an agent type is provided, `call()` infers method names, argument types, and return types from the agent's methods. A new `stub` property provides a direct RPC-style proxy — call agent methods as if they were local functions:

```typescript
const client = new AgentClient<MyAgent>({
  agent: "my-agent",
  host: window.location.host
});

// Typed call — method name autocompletes, args and return type inferred
const value = await client.call("getValue");

// Typed stub — direct RPC-style proxy
await client.stub.getValue();
await client.stub.add(1, 2);
```

State is automatically inferred from the agent type, so `onStateUpdate` is also typed:

```typescript
const client = new AgentClient<MyAgent>({
  agent: "my-agent",
  host: window.location.host,
  onStateUpdate: (state) => {
    // state is typed as MyAgent's state type
  }
});
```

**Backward compatible**

Existing untyped usage continues to work without changes:

```typescript
const client = new AgentClient({ agent: "my-agent", host: "..." });
client.call("anyMethod", [args]); // still works
client.call<number>("add", [1, 2]); // explicit return type still works
client.stub.anyMethod("arg1", 123); // untyped stub also available
```

The previous `AgentClient<State>` pattern is preserved — `new AgentClient<{ count: number }>({...})` still correctly types `onStateUpdate` and leaves `call`/`stub` untyped.

**Breaking: `call` is now an instance property instead of a prototype method**

`AgentClient.prototype.call` no longer exists. The `call` function is assigned per-instance in the constructor (via `.bind()`). This is required for the conditional type system to switch between typed and untyped signatures. Normal usage (`client.call(...)`) is unaffected, but code that reflects on the prototype or subclasses that override `call` as a method may need adjustment.

**Shared type utilities**

The RPC type utilities (`AgentMethods`, `AgentStub`, `RPCMethods`, etc.) are now exported from `agents/client` so they can be shared between `AgentClient` and `useAgent`, and are available to consumers who need them for advanced typing scenarios.
