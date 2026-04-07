# @cloudflare/shell

## 0.3.2

### Patch Changes

- [#1249](https://github.com/cloudflare/agents/pull/1249) [`bfbed21`](https://github.com/cloudflare/agents/commit/bfbed218774e3c1c1931e03484141308ac23e236) Thanks [@threepointone](https://github.com/threepointone)! - Fix `git.clone()` without `depth` failing with `ENOENT: .git/shallow`. The git fs adapter's `unlink` now wraps errors with `.code` so isomorphic-git can handle missing files gracefully.

- Updated dependencies [[`d5dbf45`](https://github.com/cloudflare/agents/commit/d5dbf45e3dfb2d93ca1ece43d2e84cea2cb28d37), [`c5ca556`](https://github.com/cloudflare/agents/commit/c5ca55618bd79042f566e55d1ebbe0636f91e75a)]:
  - @cloudflare/codemode@0.3.4

## 0.3.1

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- Updated dependencies [[`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0)]:
  - @cloudflare/codemode@0.3.3

## 0.3.0

### Minor Changes

- [#1136](https://github.com/cloudflare/agents/pull/1136) [`b545079`](https://github.com/cloudflare/agents/commit/b545079298e76ab0cb6a34f3e53bacfd1c6241f0) Thanks [@mattzcarey](https://github.com/mattzcarey)! - feat(shell): add isomorphic-git integration for workspace filesystem

  New `@cloudflare/shell/git` export with pure-JS git operations backed by the Workspace filesystem. Includes `createGit(filesystem)` for direct usage and `gitTools(workspace)` ToolProvider for codemode sandboxes with auto-injected auth tokens.

## 0.2.0

### Minor Changes

- [#1174](https://github.com/cloudflare/agents/pull/1174) [`fc7a26c`](https://github.com/cloudflare/agents/commit/fc7a26c0c32ac0ba23951c7df868c9fffc9dc8ea) Thanks [@threepointone](https://github.com/threepointone)! - Replace tagged-template SQL host interface with a plain `SqlBackend` interface. Workspace now accepts `SqlStorage`, `D1Database`, or any custom `{ query, run }` backend via a single options object. This makes Workspace usable from any Durable Object or D1 database, not just Agents.

## 0.1.1

### Patch Changes

- [#1130](https://github.com/cloudflare/agents/pull/1130) [`d46e917`](https://github.com/cloudflare/agents/commit/d46e9179c43c64ddea2ab11b305a041945f7b32c) Thanks [@threepointone](https://github.com/threepointone)! - Rewrite InMemoryFs with tree-based storage instead of flat map

## 0.1.0

### Minor Changes

- [#1122](https://github.com/cloudflare/agents/pull/1122) [`a16e74d`](https://github.com/cloudflare/agents/commit/a16e74db106a5f498e1710286023f4acfbb322be) Thanks [@threepointone](https://github.com/threepointone)! - New `@cloudflare/shell` — a sandboxed JS execution and filesystem runtime for agents, replacing the previous bash interpreter. Includes `Workspace` (durable SQLite + R2 storage), `InMemoryFs`, a unified `FileSystem` interface, `FileSystemStateBackend`, and `stateTools(workspace)` / `stateToolsFromBackend(backend)` for composing `state.*` into codemode sandbox executions as a `ToolProvider`.

### Patch Changes

- Updated dependencies [[`a16e74d`](https://github.com/cloudflare/agents/commit/a16e74db106a5f498e1710286023f4acfbb322be)]:
  - @cloudflare/codemode@0.2.2
