# 07 — Worker Bundler

`@cloudflare/worker-bundler` (`packages/worker-bundler/`) lets you build and bundle Cloudflare Workers **at runtime** — inside another Worker — without a build pipeline. This is what powers features like the dynamic Workers playground and code-mode execution environments where the LLM generates a Worker that is then immediately bundled and deployed.

---

## High-level API (`src/index.ts`, `src/app.ts`)

[Public exports and `createWorker()` in `index.ts`](../packages/worker-bundler/src/index.ts#L1-L206) — the package's public surface: re-exports of types and helpers from the subsystems below, plus `createWorker()` — the main entry point that auto-detects the entry point, installs npm dependencies, transpiles TypeScript/JSX, and either bundles everything with esbuild-wasm (`bundle: true`) or produces separate modules via Sucrase (`bundle: false`).

[`CreateAppOptions` and `CreateAppResult` interfaces in `app.ts`](../packages/worker-bundler/src/app.ts#L37-L182) — the config object and result type for `createApp()`. `CreateAppOptions` covers: `files` (virtual filesystem), `server` (entry point path), `client` (optional browser bundle entry or array), `assets` (static files map), `assetConfig`, `bundle`, `externals`, `target`, `minify`, `sourcemap`, `registry`, `jsx`, `jsxImportSource`, `define`, `loader`, `conditions`, and the esbuild-plugins escape hatch. `CreateAppResult` extends `CreateWorkerResult` with `assets`, `assetManifest`, `assetConfig`, and `clientBundles`.

[`createApp()` implementation](../packages/worker-bundler/src/app.ts#L195-L373) — three-phase function: (1) bundle each client entry point with `bundleWithEsbuild()` targeting the browser; (2) merge client outputs with user-provided static assets and call `buildAssetManifest()`; (3) bundle the server Worker (esbuild or transform-only). Returns server modules (for the isolate) and assets/manifest (for host-side serving) separately. Callers use `handleAssetRequest()` to serve assets before forwarding to the isolate.

---

## Configuration (`src/config.ts`, `src/types.ts`)

[Wrangler config parsing in `config.ts`](../packages/worker-bundler/src/config.ts#L1-L182) — `parseWranglerConfig()` reads `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc` from the virtual filesystem and extracts `main`, `compatibilityDate`, and `compatibilityFlags`. Includes `extractWranglerConfig()` (handles both snake_case TOML and camelCase JSON formats), `stripJsonComments()` (JSONC support), and `hasNodejsCompat()` (checks for the `nodejs_compat` flag, used to set esbuild's `platform: "node"`). No `BundleConfig` or `AppConfig` types exist in this file.

[Shared types in `types.ts`](../packages/worker-bundler/src/types.ts#L1-L213) — `Files` (path→content map), `Module` and `Modules` (Worker Loader output formats), `BundlerLoader` (portable loader names like `js`, `ts`, `json`, `text`, `binary`), `JsxMode`, `CreateWorkerOptions` (full options for `createWorker()`), `WranglerConfig`, and `CreateWorkerResult`. These are the common vocabulary across all subsystems. Note: `AssetMetadata`, `AssetManifest`, `InstallResult`, and `AssetStorage` live in their own modules, not here.

---

## Bundler (`src/bundler.ts`)

[bundleWithEsbuild() — virtual filesystem esbuild plugin and bundle execution](../packages/worker-bundler/src/bundler.ts#L73-L233) — the core bundling function. Constructs an esbuild `virtual-fs` plugin that intercepts all `onResolve` and `onLoad` calls to serve files from a `FileSystem` instance instead of the real disk. User-supplied plugins run before the internal plugin. Calls `esbuild.build()` with `write: false` and returns the first output file as `bundle.js`.

[Path resolution helpers, loader selection, esbuild WASM initialization, and runtime guard](../packages/worker-bundler/src/bundler.ts#L235-L421) — `resolveRelativePath()` (normalises `../`/`./` against the virtual filesystem), `getLoader()` (maps file extensions to esbuild loaders with override support), and the WASM initialisation machinery: `isCloudflareWorkersRuntime()`, `NOT_IN_WORKERS_ERROR` (thrown when called outside Workers), a `pendingWasmImport` pre-warmed at module-evaluation time to reduce first-call latency, and `initializeEsbuild()` which lazily calls `esbuild.initialize({ wasmModule, worker: false })`.

[`BundleOptions` interface](../packages/worker-bundler/src/bundler.ts#L53-L72) — the input shape: `files` (map of path → content), `entryPoint`, `externals` (modules to leave unbundled), `minify`, `sourcemap`, `jsx` runtime, `define` replacements, esbuild `plugins`.

[`bundlerOnlyOptionsWarning()` function](../packages/worker-bundler/src/bundler.ts#L27-L46) — warns when bundler-specific options (like esbuild plugins) are passed with `bundle: false`. These options are silently ignored without bundling, which can be confusing.

---

## Module resolution (`src/resolver.ts`)

[`resolveModule(specifier, options)` function](../packages/worker-bundler/src/resolver.ts#L64-L89) — resolves an ES module import specifier to a file path, following Node.js resolution rules: relative paths first, then bare specifiers (npm packages) via `package.json` `exports` field.

[`DEFAULT_EXTENSIONS` constant](../packages/worker-bundler/src/resolver.ts#L40-L48) — the file extensions tried in order: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.json`.

[`ResolveOptions` interface](../packages/worker-bundler/src/resolver.ts#L6-L26) — the resolver's context: the virtual `files` map, the `importer` path (for relative resolution), `conditions` (e.g. `["worker"]`), and `extensions`.

---

## Transformer (`src/transformer.ts`)

[transformCode() — Sucrase transpilation and file-type detection helpers](../packages/worker-bundler/src/transformer.ts#L56-L143) — `transformCode()` strips TypeScript types and transforms JSX via Sucrase (no WASM, ~20× faster than Babel). `isTypeScriptFile()`, `isJsxFile()`, `isJavaScriptFile()`, and `getOutputPath()` are file-type helpers used throughout the transformer.

[transformAndResolve() — two-pass collect-and-transform with import rewriting](../packages/worker-bundler/src/transformer.ts#L148-L269) — produces multiple modules instead of a single bundle (used when `bundle: false`). First pass: traverses all reachable imports using `parseImports()` and `resolveModule()`, builds a source→output path map. Second pass: calls `transformCode()` on each TypeScript file then rewrites import specifiers via `rewriteImports()`.

[rewriteImports(), calculateRelativePath(), and getDirectory() helpers](../packages/worker-bundler/src/transformer.ts#L271-L417) — `rewriteImports()` rewrites all import/export specifiers in transformed code to use the final output paths so the Worker Loader can match modules by name. `calculateRelativePath()` computes a `../`-relative path between two output files. `getDirectory()` extracts the directory component of a path.

[`TransformResult` and `TransformOptions` interfaces](../packages/worker-bundler/src/transformer.ts#L1-L55) — `TransformResult` carries `code` and optional `sourceMap` string. `TransformOptions` covers `filePath` (for source map references), `sourceMap`, `preserveJsx`, `jsxRuntime` (`"automatic"`, `"classic"`, or `"preserve"`), `jsxImportSource`, and `production`.

---

## TypeScript support (`src/typescript.ts`)

[TypeScript language service integration](../packages/worker-bundler/src/typescript.ts#L1-L242) — `createTypescriptLanguageService()` wires the package's `FileSystem` abstraction into `@typescript/vfs`'s virtual TypeScript environment, enabling full type-checking and completions (not just transpilation). Returns a `TypescriptFileSystem` wrapper that keeps the virtual TS environment in sync with subsequent writes and deletes. Also includes `parseTsConfig()` (reads `tsconfig.json` from the virtual FS), `createSystem()` (builds a `TypeScript.System` that delegates to the FileSystem plus bundled `lib.*.d.ts` files), and `createDefaultTypeScriptLibMap()` (fetches TypeScript 6 type definitions via the npm registry). Used by the `"./typescript"` export.

---

## Package installer (`src/installer.ts`)

[installDependencies() — entry point, installPackage() recursion, and fetchPackageMetadata()](../packages/worker-bundler/src/installer.ts#L96-L287) and [installer — resolveVersion(), fetchPackageFiles(), extractTarball(), and decompress()](../packages/worker-bundler/src/installer.ts#L289-L400) and [installer — parseTar(), readString(), isTextFile(), and hasDependencies()](../packages/worker-bundler/src/installer.ts#L402-L543) — fetches npm packages from the registry and installs them into a virtual `node_modules`. No `npm` binary required: packages are fetched as `.tgz` tarballs, gzip-decompressed via `DecompressionStream`, tar-parsed, and stored in the virtual filesystem. `installPackage()` recurses for transitive dependencies and deduplicates using an in-progress map. Packages already present in the filesystem are skipped (supports pre-warmed filesystems). `hasDependencies()` checks whether `package.json` has any entries in `dependencies`.

[`fetchWithTimeout()` helper](../packages/worker-bundler/src/installer.ts#L18-L38) — internal (non-exported) helper that wraps `fetch()` with a 30-second timeout using `AbortController`. Throws a descriptive error on timeout. Used for all registry metadata and tarball requests.

[`InstallOptions` and `InstallResult` types](../packages/worker-bundler/src/installer.ts#L61-L84) — `InstallOptions` (internal, not exported) has `dev` (whether to include devDependencies, default false) and `registry` (npm registry URL, defaults to `https://registry.npmjs.org`). `InstallResult` (exported) carries `installed` (list of `name@version` strings for packages fetched in this call) and `warnings` (e.g. missing versions, fetch failures).

---

## Asset handler (`src/asset-handler.ts`)

[`AssetStorage`, `AssetMetadata`, `AssetManifest`, and `createMemoryStorage()`](../packages/worker-bundler/src/asset-handler.ts#L20-L51) — `AssetStorage` is a pluggable interface (`get(pathname)` returning stream/buffer/string/null) so assets can be served from KV, R2, or memory. `AssetMetadata` holds `contentType` and `etag` (no content). `AssetManifest` is `Map<string, AssetMetadata>` — the routing index used for ETag checks and content-type headers without fetching content. `createMemoryStorage()` wraps a pathname→content `Record` as an `AssetStorage`.

[`AssetConfig` interface](../packages/worker-bundler/src/asset-handler.ts#L58-L91) — configuration for the asset handler: `html_handling` (`"auto-trailing-slash"` | `"force-trailing-slash"` | `"drop-trailing-slash"` | `"none"`), `not_found_handling` (`"single-page-application"` | `"404-page"` | `"none"`), `redirects` (object with `static` and `dynamic` sub-records keyed by URL pattern), and `headers` (record of glob patterns to `{ set, unset }` header rules).

[`buildAssetManifest()` and `buildAssets()` helpers](../packages/worker-bundler/src/asset-handler.ts#L136-L190) — `buildAssetManifest()` takes a pathname→content map and returns an `AssetManifest` by computing content types via `inferContentType()` and ETags (FNV-1a hash for text, SHA-256 for binary). `buildAssets()` is a convenience wrapper that returns both a manifest and an `InMemoryStorage` in one call. These are what `createApp()` calls after collecting client bundles and static assets.

---

## Virtual filesystem (`src/file-system.ts`)

[Virtual filesystem implementations in `file-system.ts`](../packages/worker-bundler/src/file-system.ts#L1-L296) — defines the `FileSystem` interface (`read`, `write`, `delete`, `list`, `flush`) and four implementations: `InMemoryFileSystem` (backed by a `Map`, for tests and build pipelines), `OverlayFileSystem` (write-overlay over any inner FS, buffers changes until `flush()`), `DurableObjectRawFileSystem` (immediate per-write KV persistence), and `DurableObjectKVFileSystem` (buffered KV writes via an overlay). Also includes `createFileSystemSnapshot()` (materialises an async iterable of `[path, content]` pairs into an `InMemoryFileSystem`) and `isFileSystem()` (type guard). Note: the esbuild plugin that *uses* a `FileSystem` lives in `bundler.ts`, not here.

---

## MIME types (`src/mime.ts`)

[`inferContentType(path)` and `isTextContentType()` functions](../packages/worker-bundler/src/mime.ts#L1-L97) — `inferContentType()` maps file extensions to MIME type strings (HTML, JS, CSS, JSON, images, fonts, media, archives, WASM, source maps). Returns `undefined` for unknown extensions. `isTextContentType()` classifies a content type as text-based (used to decide between text and binary module storage). Used by `buildAssetManifest()` and the asset handler.

---

## Asset handler details (`src/asset-handler.ts`)

The asset handler is more involved than it first appears — it implements a proper static file server with SPA support, custom headers, and redirect rules.

[normalizeConfig(), computeETag(), buildAssetManifest(), buildAssets(), and redirect handling](../packages/worker-bundler/src/asset-handler.ts#L91-L301) — `normalizeConfig()` fills in defaults and normalises the `redirects.static` record with line numbers for priority resolution. `computeETag()` uses FNV-1a for text and SHA-256 for binary. Redirect handling: `matchStaticRedirects()`, `matchDynamicRedirects()` (with glob/`:placeholder` patterns), and `handleRedirects()` (returns a redirect `Response` or a proxied pathname for status-200 rewrites).

[Custom headers, path encoding/decoding, and getIntent() HTML routing dispatcher](../packages/worker-bundler/src/asset-handler.ts#L303-L424) — `attachCustomHeaders()` applies `AssetConfig.headers` glob rules to a response (supports both `set` and `unset`). `decodePath()` and `encodePath()` handle percent-encoding on a per-segment basis. `getIntent()` dispatches to the appropriate HTML-handling mode and returns a typed `Intent` (asset, redirect, or undefined).

[htmlAutoTrailingSlash(), htmlForceTrailingSlash(), and htmlDropTrailingSlash() routing modes](../packages/worker-bundler/src/asset-handler.ts#L462-L833) — three HTML routing functions that implement the `html_handling` modes. Each resolves a requested pathname against the asset manifest following different slash conventions, using `safeRedirect()` to avoid redirect loops. They handle `/index`, `/index.html`, trailing-slash, `.html`-extension, and bare-path variants.

[htmlNone(), notFound(), cache-control helpers, and handleAssetRequest() entry point](../packages/worker-bundler/src/asset-handler.ts#L836-L995) — `htmlNone()` does an exact manifest lookup only. `notFound()` implements `not_found_handling`: SPA mode serves `/index.html` only for requests that include `text/html` in `Accept`; `404-page` mode walks up the directory tree for the nearest `404.html`. `getCacheControl()` returns immutable caching for content-hashed filenames. `handleAssetRequest()` is the public entry point: validates method (GET/HEAD only), runs redirects, decodes the path, calls `getIntent()`, handles ETag conditional requests, fetches content from storage, and applies custom headers.

[Redirect rules](../packages/worker-bundler/src/asset-handler.ts#L202-L301) — `AssetConfig.redirects` is an object with `static` and `dynamic` sub-records, both keyed by URL pattern (`{ status, to }`). Static redirects also support `https://host/path` keys for host-specific rules; conflicts are resolved by declaration order (line numbers). Dynamic redirects support `*` wildcards and `:placeholder` tokens with substitution in the destination. Processed before any HTML handling.

[Trailing-slash and HTML normalisation](../packages/worker-bundler/src/asset-handler.ts#L382-L833) — controlled by `AssetConfig.html_handling`. The default `"auto-trailing-slash"` mode transparently serves directory-style URLs with or without the slash by attempting `index.html` lookups and `safeRedirect()` where needed. `"force-trailing-slash"` always redirects to the slash form; `"drop-trailing-slash"` always redirects to the no-slash form; `"none"` does exact matching only.

[Not-found handling](../packages/worker-bundler/src/asset-handler.ts#L848-L879) — controlled by `AssetConfig.not_found_handling`. `"single-page-application"` serves `/index.html` with status 200 for requests that include `text/html` in `Accept` (skips API/fetch calls). `"404-page"` walks up the directory tree to find the nearest `404.html` and returns it with status 404. `"none"` (default) returns null so the request falls through to the user's Worker.

[Custom response headers](../packages/worker-bundler/src/asset-handler.ts#L303-L351) — `AssetConfig.headers` is a record keyed by glob pattern, each value being `{ set?: Record<string, string>, unset?: string[] }`. Multiple matching patterns are applied in order; `set` uses `append` for repeated keys, `unset` deletes headers. Useful for `Cache-Control`, `X-Frame-Options`, CORS headers, etc.

---

## Bundler utilities (`src/utils.ts`)

[Entry-point detection utilities in `utils.ts`](../packages/worker-bundler/src/utils.ts#L1-L122) — `DEFAULT_ENTRY_POINTS` (the ordered list of fallback paths tried when no entry is specified: `src/index.ts`, `src/worker.ts`, etc.), `detectEntryPoint()` (priority: wrangler `main` > `package.json` `exports`/`module`/`main` > defaults), and `formatFileListForError()` (renders a short file list for "entry point not found" errors, filtering out `node_modules/`). Not part of the public API.

---

## Module resolver details (`src/resolver.ts`)

[resolveModule(), resolveRelative(), and resolvePackage() with exports field](../packages/worker-bundler/src/resolver.ts#L64-L183) — `resolveModule()` dispatches to `resolveRelative()` for `./`/`/`-prefixed specifiers or `resolvePackage()` for bare specifiers. `resolvePackage()` looks up `node_modules/<name>/package.json`, uses the `resolve.exports` library to evaluate the `exports` field with the given conditions array (e.g. `"worker"`, `"browser"`, `"import"`), then falls back to the `module`/`main` legacy fields, then to index files.

[resolveWithExtensions(), parsePackageSpecifier(), path helpers, and import parsers](../packages/worker-bundler/src/resolver.ts#L185-L376) — `resolveWithExtensions()` tries exact path, then each extension in order, then `index.<ext>` variants. `parsePackageSpecifier()` splits a bare specifier into package name (handles `@scope/pkg`) and optional subpath. Path utilities: `getDirectory()`, `joinPaths()`, `normalizePath()`, `normalizeRelativePath()`. `parseImports()` extracts import specifiers from source code using `es-module-lexer` with a regex fallback for JSX files (used by `transformAndResolve()`).

---

## Experimental features (`src/experimental.ts`)

[Experimental warning in `experimental.ts`](../packages/worker-bundler/src/experimental.ts#L1-L11) — exports `showExperimentalWarning(fn)`, a one-shot `console.warn` emitted the first time `createWorker()` or `createApp()` is called, alerting callers that the package's API is unstable. Contains no experimental feature flags or WIP APIs; the file is purely about the warning mechanism.

---

## Build scripts

[Main build script in `scripts/build.ts`](../packages/worker-bundler/scripts/build.ts#L1-L66) — how the package itself is built: runs `tsc` for type declarations and esbuild for the JS output. Uses the same bundler package it's building (bootstrapped from the published version).

[TypeScript browser bundle script](../packages/worker-bundler/scripts/typescript-browser-bundle.ts#L1-L47) — bundles the TypeScript compiler itself for use in the browser. This is the `"./typescript"` export of the package — it lets you run type checking inside a Worker.
