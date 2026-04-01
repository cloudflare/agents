# @cloudflare/think

## 0.1.2

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#1247](https://github.com/cloudflare/agents/pull/1247) [`31c6279`](https://github.com/cloudflare/agents/commit/31c6279575c876cc5a7e69a4130e13a0c1afc630) Thanks [@threepointone](https://github.com/threepointone)! - Add `ContinuationState` to `agents/chat` — shared state container for auto-continuation lifecycle. AIChatAgent's 15 internal auto-continuation fields consolidated into one `ContinuationState` instance (no public API change). Think gains deferred continuations, resume coordination for pending continuations, `onClose` cleanup, and hibernation persistence for client tools via `think_request_context` table.

- [#1237](https://github.com/cloudflare/agents/pull/1237) [`f3d5557`](https://github.com/cloudflare/agents/commit/f3d555797934c6bd15cf5af2678f5e20aa74713a) Thanks [@threepointone](https://github.com/threepointone)! - Add `TurnQueue` to `agents/chat` — a shared serial async queue with
  generation-based invalidation for chat turn scheduling. AIChatAgent and
  Think now both use `TurnQueue` internally, unifying turn serialization
  and the epoch/clear-generation concept. Think gains proper turn
  serialization (previously concurrent chat turns could interleave).

## 0.1.1

### Patch Changes

- [#1220](https://github.com/cloudflare/agents/pull/1220) [`31d96cb`](https://github.com/cloudflare/agents/commit/31d96cb10ab1c8cbd9fd96b73d82ef55c5524138) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `@cloudflare/shell` peer dependency to require `>=0.2.0`. Previously, npm could resolve an incompatible shell version, causing runtime errors. If you hit `Workspace` constructor errors, upgrade `@cloudflare/shell` to 0.2.0 or later.

## 0.1.0

### Minor Changes

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

## 0.0.2

### Patch Changes

- [#1125](https://github.com/cloudflare/agents/pull/1125) [`3b0df53`](https://github.com/cloudflare/agents/commit/3b0df53df10899df79d80e1d1938dbad0ae39b75) Thanks [@threepointone](https://github.com/threepointone)! - first publish
