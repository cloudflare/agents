---
"agents": patch
---

Fix AgentWorkflow run() method not being called in production

The `run()` method wrapper was being set as an instance property in the constructor, but Cloudflare's RPC system invokes methods from the prototype chain. This caused the initialization wrapper to be bypassed in production, resulting in `_initAgent` never being called.

Changed to wrap the subclass prototype's `run` method directly with proper safeguards:

- Uses `Object.hasOwn()` to only wrap prototypes that define their own `run` method (prevents double-wrapping inherited methods)
- Uses a `WeakSet` to track wrapped prototypes (prevents re-wrapping on subsequent instantiations)
- Uses an instance-level `__agentInitCalled` flag to prevent double initialization if `super.run()` is called from a subclass
