# @cloudflare/worker-bundler

## 0.2.1

### Patch Changes

- [#1613](https://github.com/cloudflare/agents/pull/1613) [`124a47a`](https://github.com/cloudflare/agents/commit/124a47a91c8a9db0bcf08ab931a5dd99a2fac663) Thanks [@threepointone](https://github.com/threepointone)! - Introduce the first Think framework layer for convention-driven agent apps.

  This release adds a manifest-driven Vite plugin that discovers agents from the
  `agents/` directory, generates a Worker entrypoint and virtual framework
  modules, derives stable Durable Object class names, and merges framework-owned
  Worker config defaults with user Wrangler config. It also keeps the Think Vite
  plugin usable directly in normal Vite plugin arrays.

  The framework now supports optional app server entries, manifest-scoped friendly
  agent and sub-agent routing, deterministic route surfaces, colocated skill
  detection, Worker Loader requirement diagnostics, and explicit diagnostics for
  unsupported nested sub-agent conventions. Think currently supports top-level
  agents and one sub-agent layer; deeper nesting is rejected with guidance so that
  the routing and lifecycle model can be designed deliberately.

  This framework layer is experimental: both the Vite plugin (once, on build
  start) and the `think` CLI (on startup) emit a notice that the API may change
  or be removed in any release. The core Think agent runtime is unchanged.

  The Think CLI now includes `think init`, `think inspect`, and `think types`.
  `think init` scaffolds a minimal Workers/Vite Think app, safely handles prompted
  or named target directories, refuses unsafe migrations, and installs npm
  dependencies by default. `think inspect` exposes manifest/config diagnostics in
  text or JSON, while `think types` generates Think-owned declarations and can
  optionally compose with Wrangler type generation.

  This release also adds host-framework coverage for React Router and TanStack
  Start, updates examples to use the convention-first framework shape, and hardens
  Agents/worker-bundler virtual modules for bundled skill compatibility.

## 0.2.0

### Minor Changes

- [#1584](https://github.com/cloudflare/agents/pull/1584) [`87006e2`](https://github.com/cloudflare/agents/commit/87006e27498ee535feabd2a9bd207366f33621be) Thanks [@threepointone](https://github.com/threepointone)! - Add a `virtualModules` option to `createWorker`. Each key is an import specifier (for example `"node:fs"` or `"virtual:app/config"`) and each value is JavaScript module source made available during bundling. Only applies when `bundle: true`; in transform-only mode it is ignored with a warning.

## 0.1.3

### Patch Changes

- [`19a4c08`](https://github.com/cloudflare/agents/commit/19a4c08d97848abc2c602c921549ee7df90980ce) Thanks [@threepointone](https://github.com/threepointone)! - Bump `es-module-lexer` from `^2.0.0` to `^2.1.0`. Caret upper bound (`<3.0.0`) is unchanged.

  No API or runtime behavior change in `@cloudflare/worker-bundler` itself.

## 0.1.2

### Patch Changes

- [#1334](https://github.com/cloudflare/agents/pull/1334) [`77c8c9c`](https://github.com/cloudflare/agents/commit/77c8c9c44fd87b9d4fe37639b026adb0cbced8d7) Thanks [@threepointone](https://github.com/threepointone)! - `createWorker` and `createApp` now accept a handful of extra esbuild knobs that previously required forking or patching the package:
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

- [#1335](https://github.com/cloudflare/agents/pull/1335) [`e59388d`](https://github.com/cloudflare/agents/commit/e59388d940c780e199cfba7b74d1aaf4d4b471ec) Thanks [@threepointone](https://github.com/threepointone)! - Fix: don't crash with `Cannot find package 'gojs'` when imported from Node.

  Previously, `bundler.ts` did a top-level static `import esbuildWasm from "./esbuild.wasm"`. In the Workers runtime that resolves to a `WebAssembly.Module` natively, but in Node 22+ (e.g. Vitest on GitHub Actions CI) Node's experimental ESM-WASM loader actually parses the file and tries to resolve `esbuild-wasm`'s Go-runtime import namespace `gojs` as an npm package. That surfaced as the deeply confusing error reported in [#1306](https://github.com/cloudflare/agents/issues/1306):

  ```
  Cannot find package 'gojs' imported from
  .../@cloudflare/worker-bundler/dist/esbuild.wasm
  ```

  Two changes:
  - The `./esbuild.wasm` import is now lazy — it lives inside `initializeEsbuild()` as a dynamic `import("./esbuild.wasm")` call instead of a module-level static import. The package is now safely importable from any JavaScript runtime.
  - Before evaluating that dynamic import, the bundler checks `navigator.userAgent === "Cloudflare-Workers"`. If it's not running inside workerd, it throws an actionable error pointing the caller at `@cloudflare/vitest-pool-workers` instead of letting Node surface the cryptic `gojs` resolution failure.

  A side benefit: `createWorker({ bundle: false })` (transform-only mode, which never invokes esbuild) now also works in Node, because the WASM is never loaded on that code path.

  The README now also calls out the Workers-only requirement near the top.

  While in there, sharpened a handful of unhelpful error messages to include actionable context:
  - "Entry point/Server entry point/Client entry point ... not found" now lists the user-provided files in the bundle (skipping `node_modules/`) so it's obvious whether the path is mistyped vs. missing entirely.
  - "Could not determine entry point" now spells out the full priority list it tried (`entryPoint` option → wrangler `main` → `package.json` → defaults).
  - npm registry errors include the package name, version, registry URL, and HTTP status text — e.g. `Registry returned 404 Not Found for "hno" at https://registry.npmjs.org/hno (package not found — check the name in package.json or set the `registry` option if it lives on a private registry)`.
  - The npm fetch-timeout error names the URL and notes the registry was slow/unreachable from the Worker.
  - "Invalid package.json" includes both the path and the underlying parse error.
  - "No output generated from esbuild" now names the entry point and explains the two real-world causes (a custom plugin claiming the entry without returning contents, or the entry resolving to an externalised module).

## 0.1.1

### Patch Changes

- [#1296](https://github.com/cloudflare/agents/pull/1296) [`88170b3`](https://github.com/cloudflare/agents/commit/88170b3ef7af1cf9f6c9a812e0c98f3357199e9b) Thanks [@zebp](https://github.com/zebp)! - Fix browser bundling target by setting tsdown platform to "browser"

## 0.1.0

### Minor Changes

- [#1277](https://github.com/cloudflare/agents/pull/1277) [`0cd0487`](https://github.com/cloudflare/agents/commit/0cd0487ca6b6bd684c72d59a8349994fe82750a1) Thanks [@zebp](https://github.com/zebp)! - Introduce `FileSystem` abstraction for all bundler APIs.

  The `files` option on `createWorker` and `createApp` now accepts any `FileSystem`
  implementation in addition to a plain `Record<string, string>`. This lets callers
  back the virtual filesystem with persistent or custom storage — for example, a
  `DurableObjectKVFileSystem` that buffers writes in memory and flushes to Durable
  Object KV on demand, avoiding a KV write for every individual file operation.

  Three concrete implementations are exported from the package:
  - `InMemoryFileSystem` — a `Map`-backed filesystem suitable for tests and
    in-process pipelines. Accepts an optional seed object or `Map` of initial
    files.
  - `DurableObjectKVFileSystem` — a Durable Object KV-backed filesystem with a
    write-overlay. Writes accumulate in memory and are flushed to KV in one batch
    when `flush()` is called. Reads are served from the overlay first, so callers
    always observe their own writes immediately.
  - `DurableObjectRawFileSystem` — a thin Durable Object KV-backed filesystem
    with no buffering. Every write is committed to KV synchronously. Use when
    per-write durability is preferred over batching.

  `createFileSystemSnapshot` creates an `InMemoryFileSystem` from any sync or
  async iterable of `[path, content]` pairs, bridging async storage backends
  (e.g. `Workspace` from `@cloudflare/shell`) to the synchronous `FileSystem`
  interface.

  The `FileSystem.read()` method returns `string | null` (null = file does not
  exist) rather than an empty string, eliminating the need for a separate
  `exists()` check.

  Plain `Record<string, string>` objects continue to work unchanged — they are
  wrapped in an `InMemoryFileSystem` automatically.

- [#1277](https://github.com/cloudflare/agents/pull/1277) [`0cd0487`](https://github.com/cloudflare/agents/commit/0cd0487ca6b6bd684c72d59a8349994fe82750a1) Thanks [@zebp](https://github.com/zebp)! - Export `installDependencies`, `hasDependencies`, and `InstallResult` so callers
  can pre-warm a `FileSystem` with npm packages independently of `createWorker` or
  `createApp`.

  When `createWorker` or `createApp` encounter a `FileSystem` that already contains
  a package under `node_modules/`, that package is skipped during installation,
  avoiding redundant network fetches. This makes a second call to
  `installDependencies` (or the internal call inside `createWorker`) a no-op for
  packages that were pre-installed into the same `FileSystem`.

- [#1277](https://github.com/cloudflare/agents/pull/1277) [`0cd0487`](https://github.com/cloudflare/agents/commit/0cd0487ca6b6bd684c72d59a8349994fe82750a1) Thanks [@zebp](https://github.com/zebp)! - Add in-process TypeScript language service via `createTypescriptLanguageService`.

  `createTypescriptLanguageService` wraps any `FileSystem` in a
  `TypescriptFileSystem` that mirrors every write and delete into an underlying
  virtual TypeScript environment. Diagnostics returned by the language service
  always reflect the current state of the filesystem — an edit that fixes a type
  error immediately clears `getSemanticDiagnostics`.

  TypeScript is pre-bundled as a browser-safe artifact so it runs inside the
  Workers runtime without Node.js APIs. Lib declarations are fetched from the
  TypeScript npm tarball at runtime.

  Exposed under a separate `./typescript` subpath export to keep the TypeScript
  bundle out of the main import path.

## 0.0.4

### Patch Changes

- [#1145](https://github.com/cloudflare/agents/pull/1145) [`94fac05`](https://github.com/cloudflare/agents/commit/94fac057c5f2ad9e668c4f3c38d4a4b52b102299) Thanks [@threepointone](https://github.com/threepointone)! - Separate assets from isolate: `createApp` now returns assets for host-side serving instead of embedding them in the dynamic isolate. Removes DO wrapper code generation and `durableObject` option — mounting is the caller's concern. Preview proxy replaced with Service Worker-based URL rewriting.

## 0.0.3

### Patch Changes

- [`8fd45cf`](https://github.com/cloudflare/agents/commit/8fd45cf81aaa7eee2b97eb6c4fc2b0b3ce7b8ffd) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish (again)

## 0.0.2

### Patch Changes

- [`18c51ec`](https://github.com/cloudflare/agents/commit/18c51ec8968763396cec2fe6faadc8aa5b316abb) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish
