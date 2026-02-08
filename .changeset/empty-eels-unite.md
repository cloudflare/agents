---
"agents": patch
---

Add readonly connections: restrict WebSocket clients from modifying agent state

- New hooks: `shouldConnectionBeReadonly`, `setConnectionReadonly`, `isConnectionReadonly`
- Blocks both client-side `setState()` and mutating `@callable()` methods for readonly connections
- Readonly flag stored in a namespaced connection attachment (`_cf_readonly`), surviving hibernation without extra SQL
- Connection state wrapping hides the internal flag from user code and preserves it across `connection.setState()` calls
- Client-side `onStateUpdateError` callback for handling rejected state updates
