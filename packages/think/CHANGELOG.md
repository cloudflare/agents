# @cloudflare/think

## 0.1.0

### Minor Changes

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

## 0.0.2

### Patch Changes

- [#1125](https://github.com/cloudflare/agents/pull/1125) [`3b0df53`](https://github.com/cloudflare/agents/commit/3b0df53df10899df79d80e1d1938dbad0ae39b75) Thanks [@threepointone](https://github.com/threepointone)! - first publish
