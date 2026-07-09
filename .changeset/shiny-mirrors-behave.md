---
"agents": patch
---

Allow user-defined interfaces as agent `Props`.

Interfaces do not get implicit index signatures in TypeScript, so the previous `Record<string, unknown>` bound rejected them with "Index signature for type 'string' is missing". `Props` is now bounded by `object` on `Agent`, `McpAgent`, `getAgentByName`, and `AgentGetOptions`, so plain interfaces work as props; generic defaults stay `Record<string, unknown>`, so untyped usage still reads props values as `unknown`.

The `addMcpServer` RPC overload now also derives its `props` option type from the target `McpAgent` (`AddRpcMcpServerOptions<McpAgentProps<T>>`), so RPC props are type-checked against the agent being connected to instead of accepting any record.
