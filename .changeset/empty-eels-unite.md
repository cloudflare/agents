---
"agents": patch
---

Add readonly connection support to agents

Introduces readonly connections to restrict certain WebSocket clients from modifying agent state while allowing state updates and RPC calls. Adds server-side methods for managing readonly status, persists status in SQL for hibernation, and client-side error handling via onStateUpdateError. Updates documentation and relevant types, client, and React hook implementations.
