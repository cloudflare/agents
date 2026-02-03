---
"agents": patch
---

# Synchronous `setState` with validation hook

`setState()` is now synchronous instead of async. This improves ergonomics and aligns with the expected mental model for state updates.

## Breaking Changes

### `setState()` returns `void` instead of `Promise<void>`

```typescript
// Before (still works - awaiting a non-promise is harmless)
await this.setState({ count: 1 });

// After (preferred)
this.setState({ count: 1 });
```

Existing code that uses `await this.setState(...)` will continue to work without changes.

### `onStateUpdate()` no longer gates state broadcasts

Previously, if `onStateUpdate()` threw an error, the state update would be aborted. Now, `onStateUpdate()` runs asynchronously via `ctx.waitUntil()` after the state is persisted and broadcast. Errors in `onStateUpdate()` are routed to `onError()` but do not prevent the state from being saved or broadcast.

If you were using `onStateUpdate()` for validation, migrate to `validateStateChange()`.

## New Features

### `validateStateChange()` validation hook

A new synchronous hook that runs before state is persisted or broadcast. Use this for validation:

```typescript
validateStateChange(nextState: State, source: Connection | "server") {
  if (nextState.count < 0) {
    throw new Error("Count cannot be negative");
  }
}
```

- Runs synchronously before persistence and broadcast
- Throwing aborts the state update entirely
- Ideal for validation logic

### Execution order

1. `validateStateChange(nextState, source)` - validation (sync, gating)
2. State persisted to SQLite
3. State broadcast to connected clients
4. `onStateUpdate(nextState, source)` - notifications (async via `ctx.waitUntil`, non-gating)
