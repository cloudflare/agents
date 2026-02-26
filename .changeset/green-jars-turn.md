---
"agents": minor
---

Add `AgentContext` class for declarative runtime context lifecycle. `context = new AgentContext(this, { onStart, onClose })` returns a Proxy that transparently reads from AsyncLocalStorage. Hooks stored in WeakMap; `this.context?.traceId` works directly in any lifecycle. Removes `currentContext` getter — `this.context` IS the runtime value.
