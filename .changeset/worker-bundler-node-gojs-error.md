---
"@cloudflare/worker-bundler": patch
---

Fix: don't crash with `Cannot find package 'gojs'` when imported from Node.

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
