---
"agents": patch
---

Apply the Worker-safe `CfWorkerJsonSchemaValidator` by default on the `MCPClientManager.connect()` path, matching `createConnection()`.

RPC MCP connections made via `addMcpServer(name, namespace)` previously skipped the default, so the MCP SDK fell back to its AJV validator when a server exposed tools with `outputSchema`. AJV compiles schemas with `new Function`, which Workers disallows, failing discovery with "Code generation from strings disallowed for this context". Caller-supplied `client.jsonSchemaValidator` overrides are still respected.
