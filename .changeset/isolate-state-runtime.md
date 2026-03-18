---
"@cloudflare/shell": minor
---

New `@cloudflare/shell` — a sandboxed JS execution and filesystem runtime for agents, replacing the previous bash interpreter. Includes `Workspace` (durable SQLite + R2 storage), `InMemoryFs`, a unified `FileSystem` interface, `FileSystemStateBackend`, and `statePlugin()` for composing `state.*` into codemode sandbox executions.
