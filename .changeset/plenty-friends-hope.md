---
"agents": minor
---

### Breaking Changes

- **`getMcpServers()` is now async**: Changed from synchronous to asynchronous method to support storage operations
- **`DurableObjectOAuthClientProvider` constructor**: Now accepts `OAuthClientStorage` interface instead of `DurableObjectStorage`

### New Features

- **`MCPClientManager` API changes**:
  - New `registerServer()` method to register servers (replaces part of `connect()`)
  - New `connectToServer()` method to establish connection (replaces part of `connect()`)
  - `connect()` method deprecated (still works for backward compatibility)
  - Requires `MCPClientStorage` interface implementation (provided via `AgentMCPClientStorage`)
- **Storage abstraction layer**: New `MCPClientStorage` and `OAuthClientStorage` interfaces enable custom storage implementations beyond Durable Objects
- **Connection state observability**: New `onServerStateChanged()` event for tracking all server state changes
- **Improved reconnect logic**: `restoreConnectionsFromStorage()` handles failed connections

### Bug Fixes

- Fixed failed connections not being recreated on restore
- Fixed redundant storage operations during connection restoration
