# 07 — Worker Bundler

`@cloudflare/worker-bundler` (`packages/worker-bundler/`) lets you build and bundle Cloudflare Workers **at runtime** — inside another Worker — without a build pipeline. This is what powers features like the dynamic Workers playground and code-mode execution environments where the LLM generates a Worker that is then immediately bundled and deployed.

---

## High-level API (`src/index.ts`, `src/app.ts`)

[Public exports in `index.ts`](../packages/worker-bundler/src/index.ts#L1-L206) — the package's public surface: re-exports from the subsystems below, plus `createApp()` which is the most common entry point.

[`createApp(options)` in `app.ts`](../packages/worker-bundler/src/app.ts#L1-L373) — bundles a full-stack application: a server Worker, an optional client bundle, and static assets. Returns separate asset maps so the host can serve them. Internally calls `bundleWithEsbuild()` for the Worker, `resolveModule()` for dependencies, and `AssetHandler` for static serving.

[`CreateAppOptions` interface](../packages/worker-bundler/src/app.ts#L37-L100) — the config object for `createApp()`: `files` (virtual filesystem), `server` (entry point path), `client` (optional browser bundle entry), `assets` (static files), `bundle` (boolean), `minify`, `sourcemap`.

---

## Configuration (`src/config.ts`, `src/types.ts`)

[`BundleConfig` and `AppConfig` types](../packages/worker-bundler/src/config.ts#L1-L182) — the full configuration schemas, including default values. Shared between `bundleWithEsbuild()` and `createApp()`.

[Shared types in `types.ts`](../packages/worker-bundler/src/types.ts#L1-L213) — `BundleResult`, `AssetMetadata`, `VirtualFile`, `InstallResult`, and others. The common vocabulary across all subsystems.

---

## Bundler (`src/bundler.ts`)

[`bundleWithEsbuild(options)` function](../packages/worker-bundler/src/bundler.ts#L73-L420) — the core: runs esbuild-wasm inside the Worker to produce a single-file bundle. Takes a virtual file map (not the actual filesystem) as `files`. Supports TypeScript, JSX, custom `define` replacements, and esbuild plugins.

[`BundleOptions` interface](../packages/worker-bundler/src/bundler.ts#L53-L72) — the input shape: `files` (map of path → content), `entryPoint`, `externals` (modules to leave unbundled), `minify`, `sourcemap`, `jsx` runtime, `define` replacements, esbuild `plugins`.

[`bundlerOnlyOptionsWarning()` function](../packages/worker-bundler/src/bundler.ts#L27-L46) — warns when bundler-specific options (like esbuild plugins) are passed with `bundle: false`. These options are silently ignored without bundling, which can be confusing.

---

## Module resolution (`src/resolver.ts`)

[`resolveModule(specifier, options)` function](../packages/worker-bundler/src/resolver.ts#L64-L89) — resolves an ES module import specifier to a file path, following Node.js resolution rules: relative paths first, then bare specifiers (npm packages) via `package.json` `exports` field.

[`DEFAULT_EXTENSIONS` constant](../packages/worker-bundler/src/resolver.ts#L40-L48) — the file extensions tried in order: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.json`.

[`ResolveOptions` interface](../packages/worker-bundler/src/resolver.ts#L6-L26) — the resolver's context: the virtual `files` map, the `importer` path (for relative resolution), `conditions` (e.g. `["worker"]`), and `extensions`.

---

## Transformer (`src/transformer.ts`)

[`transformCode(code, options)` function](../packages/worker-bundler/src/transformer.ts#L56-L416) — transpiles TypeScript/JSX to plain JavaScript using **Sucrase** (no WASM, ~20× faster than Babel). Supports source maps, automatic JSX transform, and production mode. Used when `bundle: false` but transpilation is still needed.

[`TransformOptions` interface](../packages/worker-bundler/src/transformer.ts#L1-L55) — `filePath` (for source map references), `sourceMap`, `jsxRuntime` (`"automatic"` or `"classic"`), `production`.

---

## TypeScript support (`src/typescript.ts`)

[TypeScript-specific bundling helpers](../packages/worker-bundler/src/typescript.ts#L1-L242) — integration with the TypeScript compiler API for cases where full type checking (not just transpilation) is needed. Used by the `"./typescript"` export of the package.

---

## Package installer (`src/installer.ts`)

[`installDependencies(packages, options)` function](../packages/worker-bundler/src/installer.ts#L96-L542) — fetches npm packages from the registry and installs them into a virtual `node_modules`. No `npm` binary required: packages are fetched as tarballs, extracted, and stored in the virtual file map.

[`fetchWithTimeout()` helper](../packages/worker-bundler/src/installer.ts#L18-L38) — wraps `fetch()` with a 30-second timeout. Used for all registry requests.

[`InstallOptions` and `InstallResult` types](../packages/worker-bundler/src/installer.ts#L61-L84) — `InstallOptions` specifies the npm registry URL (defaults to `https://registry.npmjs.org`). `InstallResult` carries the list of installed packages and any warnings (e.g. peer dependency mismatches).

---

## Asset handler (`src/asset-handler.ts`)

[`AssetStorage` interface and `createMemoryStorage()` factory](../packages/worker-bundler/src/asset-handler.ts#L20-L51) — `AssetStorage` is a minimal interface for looking up static files by pathname. `createMemoryStorage()` builds an in-memory store from a `Map<string, content>`.

[`AssetConfig` interface](../packages/worker-bundler/src/asset-handler.ts#L58-L91) — configuration for the asset handler: trailing-slash handling, SPA fallback (serve `index.html` for unknown routes), custom redirect rules, and response headers.

[`AssetManifest` type](../packages/worker-bundler/src/asset-handler.ts#L36-L56) — a `Map<string, AssetMetadata>` that maps URL paths to metadata (content hash, content type, encoding). The bundler emits this alongside the asset files; the handler uses it for routing.

---

## Virtual filesystem (`src/file-system.ts`)

[Virtual file system used by the bundler](../packages/worker-bundler/src/file-system.ts#L1-L296) — an esbuild plugin that intercepts module resolution and load calls, serving files from a `Map<string, string>` in memory rather than the real filesystem. This is what makes bundling work inside a Worker that has no filesystem access.

---

## MIME types (`src/mime.ts`)

[`getMimeType(path)` function](../packages/worker-bundler/src/mime.ts#L1-L97) — maps file extensions to MIME type strings. Used by the asset handler when setting `Content-Type` response headers.

---

## Asset handler details (`src/asset-handler.ts`)

The asset handler is more involved than it first appears — it implements a proper static file server with SPA support, custom headers, and redirect rules.

[`AssetHandler` class](../packages/worker-bundler/src/asset-handler.ts#L91-L400) — the main class. `handle(request)` walks through the routing pipeline: check redirects → resolve path → apply trailing-slash normalisation → find asset → set content-type/encoding headers → return `Response`.

[Redirect rules](../packages/worker-bundler/src/asset-handler.ts#L400-L600) — `AssetConfig.redirects` is an array of `{from, to, status}` entries. Supports exact paths, wildcard patterns, and optional query-string passthrough. Processed before any other routing.

[Trailing-slash normalisation](../packages/worker-bundler/src/asset-handler.ts#L600-L750) — when `trailingSlash: "auto"` (the default), the handler adds a trailing slash for directory-like paths and removes it for file-like paths. Prevents 404s caused by mismatched URL forms.

[SPA fallback](../packages/worker-bundler/src/asset-handler.ts#L750-L900) — when `spaFallback: true`, any 404 that doesn't match a static asset serves `index.html` with a 200 status instead. This lets client-side routers handle deep links.

[Custom response headers](../packages/worker-bundler/src/asset-handler.ts#L900-L995) — `AssetConfig.headers` is an array of `{path, headers}` entries where `path` is a glob. Matching entries' headers are merged into the response. Useful for `Cache-Control`, `X-Frame-Options`, etc.

---

## Bundler utilities (`src/utils.ts`)

[Utility helpers in `utils.ts`](../packages/worker-bundler/src/utils.ts#L1-L122) — miscellaneous helpers used across the bundler: path normalisation, virtual file system helpers, and error formatting for build failures. Not part of the public API.

---

## Module resolver details (`src/resolver.ts`)

[Package.json `exports` field resolution](../packages/worker-bundler/src/resolver.ts#L56-L375) — the bulk of the resolver handles the `exports` field in `package.json`. This field can specify different entry points for different conditions (`"worker"`, `"browser"`, `"import"`, `"require"`). The resolver evaluates the condition array in priority order to find the right file.

---

## Experimental features (`src/experimental.ts`)

[Experimental bundler features](../packages/worker-bundler/src/experimental.ts#L1-L11) — a small file that exports experimental APIs not yet in the stable surface. Currently minimal; check here for WIP features.

---

## Build scripts

[Main build script in `scripts/build.ts`](../packages/worker-bundler/scripts/build.ts#L1-L66) — how the package itself is built: runs `tsc` for type declarations and esbuild for the JS output. Uses the same bundler package it's building (bootstrapped from the published version).

[TypeScript browser bundle script](../packages/worker-bundler/scripts/typescript-browser-bundle.ts#L1-L47) — bundles the TypeScript compiler itself for use in the browser. This is the `"./typescript"` export of the package — it lets you run type checking inside a Worker.
