---
"agents": patch
---

# Bug Fixes

This release includes three bug fixes:

## 1. Hung Callback Detection in scheduleEvery()

Fixed a deadlock where if an interval callback hung indefinitely, all future interval executions would be skipped forever.

**Fix:** Track execution start time and force reset after 30 seconds of inactivity. If a previous execution appears hung (started more than 30s ago), it is force-reset and re-executed.

```typescript
// Now safe - hung callbacks won't block future executions
await this.scheduleEvery(60, "myCallback");
```

## 2. Corrupted State Recovery

Fixed a crash when the database contains malformed JSON state.

**Fix:** Wrapped `JSON.parse` in try-catch with fallback to `initialState`. If parsing fails, the agent logs an error and recovers gracefully.

```typescript
// Agent now survives corrupted state
class MyAgent extends Agent {
  initialState = { count: 0 }; // Used as fallback if DB state is corrupted
}
```

## 3. getCallableMethods() Prototype Chain Traversal

Fixed `getCallableMethods()` to find `@callable` methods from parent classes, not just the immediate class.

**Fix:** Walk the full prototype chain using `Object.getPrototypeOf()` loop.

```typescript
class BaseAgent extends Agent {
  @callable()
  parentMethod() {
    return "parent";
  }
}

class ChildAgent extends BaseAgent {
  @callable()
  childMethod() {
    return "child";
  }
}

// Now correctly returns both parentMethod and childMethod
const methods = childAgent.getCallableMethods();
```
