---
"agents": patch
---

Fix `McpAgent.handleMcpMessage` crashing with "Attempting to read .name before it was set" when the Durable Object wakes from hibernation via native DO RPC. The method now calls `__unsafe_ensureInitialized()` to hydrate `this.name` from storage and run `onStart()` before processing messages, matching the pattern used by `_workflow_*` RPC methods and `alarm()`.
