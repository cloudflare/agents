# Worker Bundler

Dynamic bundling of Workers and full-stack apps for the Worker Loader binding. Bundles code, collects assets, and returns both — without embedding infrastructure in the isolate or deciding how the output is mounted.

**Status:** experimental (`@cloudflare/worker-bundler`)

## Problem

AI agents that generate or modify code need to bundle and run it inside dynamic isolates (Workers loaded at runtime via `env.LOADER`). A full-stack app needs both a server bundle for the isolate and static assets (HTML, CSS, JS) served alongside it.

The naive approach bundles everything into the isolate: user code, asset content, asset-serving runtime, manifest, and a generated wrapper that ties them together. This works but has problems:

- The isolate contains ~1000 lines of asset-handling infrastructure alongside user code
- Every asset (HTML, CSS, JS files) is loaded as a module inside the isolate
- Asset requests require entering the isolate even though they don't touch user code
- The bundler generates wrapper code that decides how the output is mounted (module worker vs. Durable Object), mixing bundling concerns with runtime concerns

## How it works

### `createApp`

Three steps, no code generation:

1. **Bundle client code.** Each client entry point is bundled with esbuild targeting the browser. Outputs are added to the asset pool.
2. **Collect assets.** User-provided static assets and client bundle outputs are merged. An asset manifest is computed (content types, ETags) — metadata only, no content duplication.
3. **Bundle server code.** The server entry point is bundled (or transformed) with esbuild targeting Workers. This produces `{ mainModule, modules }`.

The result separates the two concerns cleanly:

```
{
  // For the isolate — just the user's server code
  mainModule: "bundle.js",
  modules: { "bundle.js": "..." },

  // For the host — asset serving data
  assets: { "/index.html": "...", "/app.js": "..." },
  assetManifest: Map { "/index.html" => { contentType, etag }, ... },
  assetConfig: { not_found_handling: "single-page-application" }
}
```

### Caller pattern

The caller loads the bundle into the isolate and handles asset serving on the host:

```ts
const result = await createApp({ files, server: "src/server.ts", assets });

// Load into isolate
const worker = env.LOADER.get(id, () => ({
  mainModule: result.mainModule,
  modules: result.modules
}));

// On each request: check assets first, forward misses to the isolate
const storage = createMemoryStorage(result.assets);
const assetResponse = await handleAssetRequest(
  request,
  result.assetManifest,
  storage,
  result.assetConfig
);
if (assetResponse) return assetResponse;
return worker.getEntrypoint().fetch(request);
```

For Durable Object mounting, the caller uses `getDurableObjectClass` directly:

```ts
const facet = ctx.facets.get("app", () => ({
  class: worker.getDurableObjectClass("App"),
  id: "app"
}));
```

The bundler doesn't know or care which path the caller takes.

## Key decisions

### Asset serving is the host's responsibility

The host (parent Worker or Durable Object) handles all asset requests. The isolate never sees them.

**Why:** Asset serving is infrastructure, not user code. It involves ~1000 lines of logic (HTML mode resolution, trailing slash handling, redirects, custom headers, ETag/304, SPA fallback, 404 pages). Embedding this in the isolate means every dynamically loaded worker carries this overhead. Worse, asset requests must enter the isolate just to be served — wasting isolate spin-up time on what is effectively a static file lookup.

With host-side serving, asset requests are resolved before the isolate is even touched. The isolate only receives requests that actually need user code. This also means the isolate's module set is smaller (no `__assets/*` modules, no `__asset-manifest.json`, no `__asset-runtime.js`).

The caller adds three lines: create storage, check assets, fall through. `handleAssetRequest` and `createMemoryStorage` are exported from the package for exactly this purpose. Custom storage backends (KV, R2, Workspace) can be plugged in by implementing the `AssetStorage` interface.

### The bundler doesn't decide how output is mounted

`createApp` returns the user's server bundle as `mainModule` directly. It does not generate wrapper code, does not create Durable Object class shims, and does not export a `durableObjectClassName`.

**Why:** How a bundle gets mounted is a runtime decision that depends on the caller's architecture:

- **Module worker:** `worker.getEntrypoint().fetch(request)` — simplest, stateless
- **Durable Object class:** `worker.getDurableObjectClass("App")` — for persistent storage via `this.ctx.storage`
- **Facet:** `ctx.facets.get("app", () => ({ class: ..., id: "app" }))` — colocated child DO with isolated SQLite

The bundler has no way to know which is appropriate. Previously, a `durableObject: true` option generated a wrapper class that extended the user's export. This was problematic:

- If the user already exported a DO class, the wrapper was a no-op identity subclass
- If the user exported a plain `{ fetch() {} }` object, wrapping it in a DO was a surprising hidden behavior — the user didn't ask for persistence
- The generated class name was an arbitrary convention (`"App"`) that the caller had to know about anyway
- It mixed bundling concerns with mounting concerns

Now the bundler's contract is simple: you give it source files, it gives you a bundle and assets. What you do with them is up to you.

## Tradeoffs

**Caller must wire up asset serving.** The output is not a self-contained "drop into any Loader" bundle. The caller participates by calling `handleAssetRequest` before forwarding to the isolate. This is three lines of code using exported utilities, but it is a requirement — forgetting it means assets won't be served.

**Caller must know the exported class name.** For DO mounting, the caller passes the class name string to `getDurableObjectClass("App")`. There's no auto-detection. In practice this is fine because the caller controls the system prompt or code template that generates the user code, so they know what class name to expect.

**No normalization of plain objects into DOs.** If the user's code exports `export default { fetch() {} }` and the caller wants DO semantics, the caller must handle that mismatch. The bundler won't silently wrap it. This is intentional — silent wrapping was a source of confusion.

**Asset manifest is computed eagerly.** `createApp` computes ETags for all assets at build time even if the caller uses a custom storage backend. The manifest computation is fast (FNV-1a for text, SHA-256 for binary) and the data is small, so this is acceptable. A lazy alternative would complicate the API for negligible gain.
