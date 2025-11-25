---
"agents": patch
---

### New Features

- **`MCPClientManager` API changes**:
  - New `registerServer()` method to register servers (replaces part of `connect()`)
  - New `connectToServer()` method to establish connection (replaces part of `connect()`)
  - `connect()` method deprecated (still works for backward compatibility)
- **Connection state observability**: New `onServerStateChanged()` event for tracking all server state changes
- **Improved reconnect logic**: `restoreConnectionsFromStorage()` handles failed connections

### Bug Fixes

- Fixed failed connections not being recreated on restore
- Fixed redundant storage operations during connection restoration
- Fixed potential OAuth storage initialization issue by excluding non-serializable authProvider from stored server options
- Added defensive checks for storage initialization in MCPClientManager and DurableObjectOAuthClientProvider
- Fixed initialization order: MCPClientManager is now created AFTER database tables are created to prevent possible table-not-found errors during DO restart
