# @cloudflare/shell

## 0.1.0

### Minor Changes

- [#1122](https://github.com/cloudflare/agents/pull/1122) [`a16e74d`](https://github.com/cloudflare/agents/commit/a16e74db106a5f498e1710286023f4acfbb322be) Thanks [@threepointone](https://github.com/threepointone)! - New `@cloudflare/shell` — a sandboxed JS execution and filesystem runtime for agents, replacing the previous bash interpreter. Includes `Workspace` (durable SQLite + R2 storage), `InMemoryFs`, a unified `FileSystem` interface, `FileSystemStateBackend`, and `stateTools(workspace)` / `stateToolsFromBackend(backend)` for composing `state.*` into codemode sandbox executions as a `ToolProvider`.

### Patch Changes

- Updated dependencies [[`a16e74d`](https://github.com/cloudflare/agents/commit/a16e74db106a5f498e1710286023f4acfbb322be)]:
  - @cloudflare/codemode@0.2.2
