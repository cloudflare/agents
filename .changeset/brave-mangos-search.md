---
"agents": patch
---

Always apply the Worker-safe `CfWorkerJsonSchemaValidator` to MCP client connections by default.

`MCPClientConnection` now owns the default (merged in its constructor), so every construction path uses the Worker-safe validator unless the caller supplies their own — including the RPC `addMcpServer(name, namespace)` path via `MCPClientManager.connect()`, which previously skipped it. Without the default, the MCP SDK fell back to its AJV validator when a server exposed tools with `outputSchema`; AJV compiles schemas with `new Function`, which Workers disallows, failing discovery with "Code generation from strings disallowed for this context".

`connect()` now builds connections through `createConnection()` instead of duplicating construction, so the two paths can no longer drift. Caller-supplied `client.jsonSchemaValidator` overrides are respected on the live connection; because validator instances cannot survive JSON serialization, they are no longer persisted, and a previously persisted, serialization-degraded validator is ignored on restore — after hibernation the connection falls back to the Worker-safe default instead of failing discovery.
