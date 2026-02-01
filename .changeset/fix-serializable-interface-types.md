---
"agents": patch
---

fix: improve type inference for RPC methods returning custom interfaces

Previously, `RPCMethod` used `{ [key: string]: SerializableValue }` to check if return types were serializable. This didn't work with TypeScript interfaces that have named properties (like `interface CoreState { counter: number; name: string; }`), causing those methods to be incorrectly excluded from typed RPC calls.

Now uses a recursive `CanSerialize<T>` type that checks if all properties of an object are serializable, properly supporting:

- Custom interfaces with named properties
- Nested object types
- Arrays of objects
- Optional and nullable properties
- Union types

Also expanded `NonSerializable` to explicitly exclude non-JSON-serializable types like `Date`, `RegExp`, `Map`, `Set`, `Error`, and typed arrays.

```typescript
// Before: these methods were NOT recognized as callable
interface MyState {
  counter: number;
  items: string[];
}

class MyAgent extends Agent<Env, MyState> {
  @callable()
  getState(): MyState {
    return this.state;
  } // ❌ Not typed
}

// After: properly recognized and typed
const agent = useAgent<MyAgent, MyState>({ agent: "my-agent" });
agent.call("getState"); // ✅ Typed as Promise<MyState>
```
