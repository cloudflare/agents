---
"agents": patch
---

Derive `callbackHost` from `connection.uri` in `addMcpServer` when called from a `@callable` method over WebSocket. Previously, `callbackHost` had to be passed explicitly (or read from an env var) because the WebSocket `onMessage` context has no HTTP request to derive the host from. Now the host is automatically extracted from the WebSocket connection's original upgrade URL, so `addMcpServer("name", url)` works without any extra options in callables. Also adds `vite/client` to the shared `agents/tsconfig` types for TS6 compatibility with CSS side-effect imports.
