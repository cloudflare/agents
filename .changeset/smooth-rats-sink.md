---
"agents": patch
---

### Breaking

- ClientConnection.init() no long tries discovery automatically. That should be done from the MCPCLientManager after explicitely setting the server to "discovering"

### Features

- New discoverIfConnected() function on MCPClientManager which allows for simpler discover of my capabilities per server.

### Fixes

- MCP Client Discovery failures now throw errors immediately instead of continuing with empty arrays
- Added new "connected" MCP Connection State to use for a connected server with no tools loaded
- Created the enum MCPConnectionState to formalise possible states
