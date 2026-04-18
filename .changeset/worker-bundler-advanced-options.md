---
"@cloudflare/worker-bundler": patch
---

`createWorker` and `createApp` now accept a handful of extra esbuild knobs that previously required forking or patching the package:

- `jsx` (`"transform" | "preserve" | "automatic"`)
- `jsxImportSource`
- `define` (compile-time constant replacement)
- `loader` (per-extension loader overrides — e.g. `{ ".svg": "text", ".wasm": "binary" }`; built-in handling for `.ts`/`.tsx`/`.js`/`.jsx`/`.json`/`.css` is preserved unless overridden, and longer extensions match first so `".d.ts"` wins over `".ts"`). The accepted values are deliberately narrowed to the portable `BundlerLoader` set (`js`/`jsx`/`ts`/`tsx`/`json`/`css`/`text`/`binary`/`base64`/`dataurl`) — esbuild-specific loaders like `file`/`copy`/`empty`/`default` are intentionally excluded. `file`/`copy` would silently break in this bundler today (they emit secondary output files that get discarded), and anything outside the portable set should go through the plugin escape hatch instead.
- `conditions` (package export conditions, e.g. `["workerd", "worker", "browser"]`)

The first five are re-typed locally (`JsxMode`, `BundlerLoader`) so the published `.d.ts` does not import from `esbuild-wasm` — a future bundler swap is a refactor, not a breaking type change.

For advanced consumers (RSC-style transforms, custom asset pipelines, codegen) there is also an explicit escape hatch:

```ts
__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: unknown[]
```

The deliberately unwieldy name is the API contract: this option is **not** covered by semver, can change shape or be removed in any release, and ties the caller to esbuild's plugin shape — if this package switches bundlers, plugins authored against it will break. It is typed as `unknown[]` at the public boundary (cast `Plugin[]` from `esbuild-wasm` when passing in) so the published types don't acquire a hard dependency on esbuild. User plugins run before the internal virtual-filesystem plugin, so their `onResolve`/`onLoad` claims fire first.

In `createApp`, all of these options apply to both the server and client bundles.

The internal `bundleWithEsbuild` signature was refactored from a long positional argument list to a single options object so future bundler knobs can be added without churning every call site. This is an internal change; no public API moved.

Inspired by [#1321](https://github.com/cloudflare/agents/issues/1321) — thanks @bndkt for the draft and the RSC-on-Workers proof-of-concept that motivated it.
