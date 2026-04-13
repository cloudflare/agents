# @cloudflare/worker-bundler

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
