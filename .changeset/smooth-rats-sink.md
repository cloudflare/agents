---
"agents": patch
---

- `MCPClientConnection.init()` no longer triggers discovery automatically. Discovery should be done via `discover()` or through `MCPClientManager.discoverIfConnected()`

### Features

- New `discover()` method on `MCPClientConnection` with full lifecycle management:
  - Handles state transitions (CONNECTED → DISCOVERING → READY on success, CONNECTED on failure)
  - Supports cancellation via AbortController (cancels previous in-flight discovery)
  - Configurable timeout (default 15s)
- New `cancelDiscovery()` method to abort in-flight discoveries
- New `discoverIfConnected()` on `MCPClientManager` for simpler capability discovery per server
- `createConnection()` now returns the connection object for immediate use
- Created `MCPConnectionState` enum to formalize possible states: `idle`, `connecting`, `authenticating`, `connected`, `discovering`, `ready`, `failed`

### Fixes

- **Fixed discovery hanging on repeated requests** - New discoveries now cancel previous in-flight ones via AbortController
- **Fixed Durable Object crash-looping** - `restoreConnectionsFromStorage()` now starts connections in background (fire-and-forget) to avoid blocking `onStart` and causing `blockConcurrencyWhile` timeouts
- **Fixed OAuth callback race condition** - When `auth_url` exists in storage during restoration, state is set to AUTHENTICATING directly instead of calling `connectToServer()` which was overwriting the state
- **Set discovery timeout to 15s**
- MCP Client Discovery failures now throw errors immediately instead of continuing with empty arrays
- Added "connected" state to represent a connected server with no tools loaded yet
