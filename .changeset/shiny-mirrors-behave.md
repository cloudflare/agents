---
"agents": patch
---

Allow user-defined interfaces as agent `Props`.

Interfaces do not get implicit index signatures in TypeScript, so the previous `Record<string, unknown>` bound rejected them with "Index signature for type 'string' is missing". A shared `AgentProps` bound (exported from `agents`) is now used everywhere props are typed — the `Agent`, `McpAgent`, `getAgentByName`, and `AgentGetOptions` generics, the `addMcpServer` RPC constraint and its `props` option, and the RPC client transport options — so plain interfaces work as props. Generic defaults stay `Record<string, unknown>`, so untyped usage still reads props values as `unknown`.
