# @cloudflare/shell

## 0.3.7

### Patch Changes

- [#1521](https://github.com/cloudflare/agents/pull/1521) [`2911bae`](https://github.com/cloudflare/agents/commit/2911bae6c7a0e331de9cb8471ab877aee2a385d2) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Preserve binary values across codemode tool calls so `Uint8Array` arguments and results survive the sandbox boundary. This fixes `state.writeFileBytes()` from codemode with byte arrays and keeps `readFileBytes()` results as `Uint8Array` values.

## 0.3.6

### Patch Changes

- [#1431](https://github.com/cloudflare/agents/pull/1431) [`e430847`](https://github.com/cloudflare/agents/commit/e4308478f90d238e3711fff0f52160b36cfabe1f) Thanks [@threepointone](https://github.com/threepointone)! - Add hidden default Basic auth credentials for shell git tool providers.

## 0.3.5

### Patch Changes

- [`19a4c08`](https://github.com/cloudflare/agents/commit/19a4c08d97848abc2c602c921549ee7df90980ce) Thanks [@threepointone](https://github.com/threepointone)! - Bump dependencies: `isomorphic-git` from `^1.37.5` to `^1.37.6` (runtime) and `@cloudflare/vitest-pool-workers` from `^0.15.0` to `^0.15.1` (devDependency, test-only — does not affect the published artifact).

  No API or runtime behavior change in `@cloudflare/shell` itself.

## 0.3.4

### Patch Changes

- [#1384](https://github.com/cloudflare/agents/pull/1384) [`a7059d4`](https://github.com/cloudflare/agents/commit/a7059d4a5a1071a10c60be0e777968fc7ff5d36c) Thanks [@threepointone](https://github.com/threepointone)! - Introduce `WorkspaceFsLike` — the minimum `Workspace` surface required by `WorkspaceFileSystem` and `createWorkspaceStateBackend`.

  `WorkspaceFileSystem`'s constructor and `createWorkspaceStateBackend`'s parameter both now accept any `WorkspaceFsLike` (a `Pick<Workspace, …>` of the 16 filesystem methods the adapter reaches for) rather than a concrete `Workspace`. Non-breaking — `Workspace` still satisfies `WorkspaceFsLike` so every existing call site keeps working without changes.

  This unlocks wrapping a real `Workspace` behind your own layer — most commonly a cross-DO proxy that forwards each call to a parent agent's workspace over RPC — and still using it as the storage for codemode's `state.*` sandbox API via `createWorkspaceStateBackend`. See `examples/assistant` for the end-to-end pattern with `SharedWorkspace`.

## 0.3.3

### Patch Changes

- [#1333](https://github.com/cloudflare/agents/pull/1333) [`dce4d17`](https://github.com/cloudflare/agents/commit/dce4d17b5f386ea9adcb5f602be78bb7d7ed83d8) Thanks [@threepointone](https://github.com/threepointone)! - `Workspace` is now idempotent on duplicate construction for the same `{sql, namespace}` when the options that affect durable storage (`r2`, `r2Prefix`, `inlineThreshold`) agree. Previously, any second construction threw `Workspace namespace "<ns>" is already registered on this agent`, which wedged legitimate cases — most commonly Vite HMR re-evaluating a Durable Object's module against a still-live `ctx.storage.sql`, and helpers that accept a `sql` and construct a short-lived `Workspace` alongside an existing class-field one.

  The guard is preserved where it actually catches a bug: if a second construction passes a different `r2`, `r2Prefix`, or `inlineThreshold`, the constructor throws with a message naming the disagreeing field and both values — because diverging storage options silently route large files to different R2 keys or classify them at different sizes, so reads through one instance would fail to find data written via the other.

  `onChange` is intentionally not part of the consistency check — each `Workspace` instance calls its own listener for its own writes, which is the existing per-instance semantic.

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
