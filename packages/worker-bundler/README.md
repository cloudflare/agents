# worker-bundler

> **Experimental**: This package is under active development and its API may change without notice. Not recommended for production use.

Bundle and serve full-stack applications on Cloudflare's [Worker Loader binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) (closed beta). Dynamically generate Workers with real npm dependencies, or build complete apps with client-side bundles and static asset serving.

## Runtime requirement

This package only runs **inside the Cloudflare Workers runtime (`workerd`)** — both in production and in `wrangler dev`. It bundles via an `esbuild-wasm` `WebAssembly.Module` import that only the Workers module loader can resolve.

It will **not** work under plain Node.js. In particular, importing it from a Vitest/Jest test that uses the default Node pool will surface an error pointing you here. To test code that depends on `@cloudflare/worker-bundler`, run your tests with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) so the test body executes inside `workerd`. See `packages/worker-bundler/src/tests/vitest.config.ts` in this repo for an example setup.

## Installation

```
npm install @cloudflare/worker-bundler
```

## Quick Start

### Bundle a Worker

Provide source code and dependencies — the bundler handles the rest:

```ts
import { createWorker } from "@cloudflare/worker-bundler";

const worker = env.LOADER.get("my-worker", async () => {
  const { mainModule, modules } = await createWorker({
    files: {
      "src/index.ts": `
        import { Hono } from 'hono';
        import { cors } from 'hono/cors';

        const app = new Hono();
        app.use('*', cors());
        app.get('/', (c) => c.text('Hello from Hono!'));
        app.get('/json', (c) => c.json({ message: 'It works!' }));

        export default app;
      `,
      "package.json": JSON.stringify({
        dependencies: { hono: "^4.0.0" }
      })
    }
  });

  return { mainModule, modules, compatibilityDate: "2026-01-01" };
});

await worker.getEntrypoint().fetch(request);
```

### Build a Full-Stack App

Use `createApp` to bundle a server Worker, client-side JavaScript, and static assets together. Assets are returned separately for host-side serving — they are not embedded in the isolate:

```ts
import {
  createApp,
  handleAssetRequest,
  createMemoryStorage
} from "@cloudflare/worker-bundler";

const result = await createApp({
  files: {
    "src/server.ts": `
      export default {
        fetch(request) {
          return new Response("API response");
        }
      }
    `,
    "src/client.ts": `
      document.getElementById("app").textContent = "Hello from the client!";
    `
  },
  server: "src/server.ts",
  client: "src/client.ts",
  assets: {
    "/index.html":
      "<!DOCTYPE html><div id='app'></div><script src='/client.js'></script>",
    "/favicon.ico": favicon
  },
  assetConfig: {
    not_found_handling: "single-page-application"
  }
});

const worker = env.LOADER.get("my-app", () => ({
  mainModule: result.mainModule,
  modules: result.modules,
  compatibilityDate: "2026-01-01"
}));

// Serve assets on the host, forward the rest to the isolate
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

Static assets are served with proper content types, ETags, and caching. Requests that don't match an asset fall through to your server code.

## API

### `createWorker(options)`

Bundles source files into a Worker.

| Option                                                   | Type                                       | Default                        | Description                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `files`                                                  | `Record<string, string> \| FileSystem`     | _required_                     | Input files — plain object or any `FileSystem` implementation                                                                                                      |
| `entryPoint`                                             | `string`                                   | auto-detected                  | Entry point file path                                                                                                                                              |
| `bundle`                                                 | `boolean`                                  | `true`                         | Bundle all dependencies into one file                                                                                                                              |
| `externals`                                              | `string[]`                                 | `[]`                           | Modules to exclude from bundling (`cloudflare:*` always external)                                                                                                  |
| `target`                                                 | `string`                                   | `'es2022'`                     | Target environment                                                                                                                                                 |
| `minify`                                                 | `boolean`                                  | `false`                        | Minify output                                                                                                                                                      |
| `sourcemap`                                              | `boolean`                                  | `false`                        | Generate inline source maps                                                                                                                                        |
| `registry`                                               | `string`                                   | `'https://registry.npmjs.org'` | npm registry URL                                                                                                                                                   |
| `jsx`                                                    | `"transform" \| "preserve" \| "automatic"` | esbuild default                | JSX transform mode                                                                                                                                                 |
| `jsxImportSource`                                        | `string`                                   | esbuild default                | JSX runtime import source (e.g. `"react"`, `"preact"`)                                                                                                             |
| `define`                                                 | `Record<string, string>`                   | `{}`                           | Constant replacements applied at bundle time                                                                                                                       |
| `loader`                                                 | `Record<string, BundlerLoader>`            | `{}`                           | Per-extension loader overrides (e.g. `{ ".svg": "text", ".wasm": "binary" }`). See [Advanced bundler options](#advanced-bundler-options) for the supported set.    |
| `conditions`                                             | `string[]`                                 | esbuild default                | Package export conditions to honour during resolution                                                                                                              |
| `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired` | `unknown[]`                                | `[]`                           | Escape hatch: extra esbuild plugins, run before the internal virtual-fs plugin. Not covered by semver — see [Advanced bundler options](#advanced-bundler-options). |

Returns:

```ts
{
  mainModule: string;
  modules: Record<string, string | Module>;
  wranglerConfig?: WranglerConfig;
  warnings?: string[];
}
```

### `createApp(options)`

Builds a full-stack app: server Worker + client bundle + static assets.

| Option                                                   | Type                                       | Default         | Description                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`                                                  | `Record<string, string> \| FileSystem`     | _required_      | All source files — plain object or any `FileSystem`                                                                                          |
| `server`                                                 | `string`                                   | auto-detected   | Server entry point (Worker fetch handler)                                                                                                    |
| `client`                                                 | `string \| string[]`                       | —               | Client entry point(s) to bundle for the browser                                                                                              |
| `assets`                                                 | `Record<string, string \| ArrayBuffer>`    | —               | Static assets (pathname → content)                                                                                                           |
| `assetConfig`                                            | `AssetConfig`                              | —               | Asset serving configuration                                                                                                                  |
| `bundle`                                                 | `boolean`                                  | `true`          | Bundle server dependencies                                                                                                                   |
| `externals`                                              | `string[]`                                 | `[]`            | Modules to exclude from bundling                                                                                                             |
| `target`                                                 | `string`                                   | `'es2022'`      | Server target environment                                                                                                                    |
| `minify`                                                 | `boolean`                                  | `false`         | Minify output                                                                                                                                |
| `sourcemap`                                              | `boolean`                                  | `false`         | Generate source maps                                                                                                                         |
| `registry`                                               | `string`                                   | npm default     | npm registry URL                                                                                                                             |
| `jsx`                                                    | `"transform" \| "preserve" \| "automatic"` | esbuild default | JSX transform mode (applied to both server and client bundles)                                                                               |
| `jsxImportSource`                                        | `string`                                   | esbuild default | JSX runtime import source (e.g. `"react"`, `"preact"`)                                                                                       |
| `define`                                                 | `Record<string, string>`                   | `{}`            | Constant replacements applied at bundle time (both server and client)                                                                        |
| `loader`                                                 | `Record<string, BundlerLoader>`            | `{}`            | Per-extension loader overrides (e.g. `{ ".svg": "text" }`). See [Advanced bundler options](#advanced-bundler-options) for the supported set. |
| `conditions`                                             | `string[]`                                 | esbuild default | Package export conditions to honour during resolution                                                                                        |
| `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired` | `unknown[]`                                | `[]`            | Escape hatch: extra esbuild plugins. See [Advanced bundler options](#advanced-bundler-options).                                              |

Returns everything from `createWorker` plus:

```ts
{
  assets: Record<string, string | ArrayBuffer>;  // Combined assets for host-side serving
  assetManifest: AssetManifest;        // Metadata (content types, ETags) per asset
  assetConfig?: AssetConfig;           // The asset config used
  clientBundles?: string[];            // Output paths of client bundles
}
```

### `handleAssetRequest(request, manifest, storage, config?)`

Standalone async asset request handler. The manifest holds routing metadata (content types, ETags) while the storage backend provides content on demand:

```ts
import { handleAssetRequest, buildAssets } from "@cloudflare/worker-bundler";

const { manifest, storage } = await buildAssets({
  "/index.html": "<h1>Hello</h1>",
  "/app.js": "console.log('hi')"
});

export default {
  async fetch(request) {
    const assetResponse = await handleAssetRequest(request, manifest, storage, {
      not_found_handling: "single-page-application"
    });
    if (assetResponse) return assetResponse;

    // Fall through to your API logic
    return new Response("API");
  }
};
```

Returns a `Promise<Response | null>` — a `Response` if an asset matches, or `null` to fall through.

## Storage Hooks

The asset handler separates **manifest** (routing metadata) from **storage** (content retrieval). This lets you plug in any backend.

### `AssetStorage` Interface

```ts
interface AssetStorage {
  get(pathname: string): Promise<ReadableStream | ArrayBuffer | string | null>;
}
```

### Built-in: In-Memory Storage

The simplest option — stores everything in memory:

```ts
import {
  buildAssetManifest,
  createMemoryStorage
} from "@cloudflare/worker-bundler";

const assets = { "/index.html": "<h1>Hi</h1>" };
const manifest = await buildAssetManifest(assets);
const storage = createMemoryStorage(assets);
```

Or use the convenience function that returns both:

```ts
import { buildAssets } from "@cloudflare/worker-bundler";

const { manifest, storage } = await buildAssets({
  "/index.html": "<h1>Hi</h1>"
});
```

### Custom: KV Storage

```ts
import type { AssetStorage } from "@cloudflare/worker-bundler";

function createKVStorage(kv: KVNamespace): AssetStorage {
  return {
    async get(pathname) {
      return kv.get(pathname, "arrayBuffer");
    }
  };
}
```

### Custom: R2 Storage

```ts
function createR2Storage(bucket: R2Bucket, prefix = "assets"): AssetStorage {
  return {
    async get(pathname) {
      const obj = await bucket.get(`${prefix}${pathname}`);
      return obj?.body ?? null;
    }
  };
}
```

### Custom: Workspace Storage

```ts
import type { Workspace } from "@cloudflare/shell";

function createWorkspaceStorage(workspace: Workspace): AssetStorage {
  return {
    async get(pathname) {
      return workspace.readFile(pathname);
    }
  };
}
```

All storage backends work with the same `handleAssetRequest` — just pass a different `storage` argument.

## Asset Configuration

### HTML Handling

Controls how HTML files are resolved and how trailing slashes are handled:

| Mode                   | Behavior                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `auto-trailing-slash`  | `/about` serves `about.html`; `/blog/` serves `blog/index.html` |
| `force-trailing-slash` | Redirects `/about` → `/about/`, serves from `index.html`        |
| `drop-trailing-slash`  | Redirects `/about/` → `/about`, serves from `.html`             |
| `none`                 | Exact path matching only                                        |

Default: `auto-trailing-slash`

### Not-Found Handling

| Mode                      | Behavior                                           |
| ------------------------- | -------------------------------------------------- |
| `single-page-application` | Serves `/index.html` for all unmatched routes      |
| `404-page`                | Serves nearest `404.html` walking up the directory |
| `none`                    | Returns `null` (fall through to your Worker)       |

Default: `none`

### Redirects

```ts
{
  redirects: {
    static: {
      "/old-page": { status: 301, to: "/new-page" }
    },
    dynamic: {
      "/blog/:slug": { status: 302, to: "/posts/:slug" },
      "/docs/*": { status: 301, to: "/wiki/*" }
    }
  }
}
```

Dynamic redirects support `:placeholder` tokens and `*` splat patterns.

### Custom Headers

```ts
{
  headers: {
    "/*": {
      set: { "X-Frame-Options": "DENY" }
    },
    "/api/*": {
      set: { "Access-Control-Allow-Origin": "*" },
      unset: ["X-Frame-Options"]
    }
  }
}
```

Patterns use glob syntax. Rules are applied in order — later rules can override earlier ones.

### Caching

The asset handler sets cache headers automatically:

- **HTML and non-hashed files**: `public, max-age=0, must-revalidate`
- **Hashed files** (e.g. `app.a1b2c3d4.js`): `public, max-age=31536000, immutable`
- **ETag support**: Conditional requests with `If-None-Match` return `304 Not Modified`

## Entry Point Detection

Priority order for `createWorker` (and `createApp` server entry):

1. Explicit `entryPoint` / `server` option
2. `main` field in wrangler config
3. `exports`, `module`, or `main` field in `package.json`
4. Default paths: `src/index.ts`, `src/index.js`, `index.ts`, `index.js`

## Mounting as a Durable Object

`createApp` bundles code and collects assets — how the output is mounted is the caller's concern. If the user's code exports a `DurableObject` subclass, load it with `getDurableObjectClass` and mount it as a facet for persistent storage.

`getDurableObjectClass(name)` resolves a **named** class export — so export the class with `export class App`, not `export default class App`. The default entrypoint slot cannot hold an actor class, and a default-exported `DurableObject` will surface as an opaque internal error when the facet is invoked.

```ts
const result = await createApp({
  files: {
    "src/server.ts": `
      import { DurableObject } from 'cloudflare:workers';

      export class App extends DurableObject {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname === '/api/count') {
            const count = ((await this.ctx.storage.get('count')) as number) ?? 0;
            await this.ctx.storage.put('count', count + 1);
            return Response.json({ count });
          }
          return new Response('Not found', { status: 404 });
        }
      }
    `
  },
  assets: {
    "/index.html": "<!DOCTYPE html><h1>Counter</h1>"
  }
});

// Load the bundle and get the DO class
const worker = env.LOADER.get(loaderId, () => ({
  mainModule: result.mainModule,
  modules: result.modules,
  compatibilityDate: "2026-01-28"
}));

// Mount as a facet for persistent storage
const facet = this.ctx.facets.get("app", () => ({
  class: worker.getDurableObjectClass("App"),
  id: "app"
}));

// Serve assets on the host, forward the rest to the facet
const storage = createMemoryStorage(result.assets);
const assetResponse = await handleAssetRequest(
  request,
  result.assetManifest,
  storage,
  result.assetConfig
);
if (assetResponse) return assetResponse;
return facet.fetch(request);
```

The facet gets its own isolated SQLite storage that persists independently of the host DO's storage. Abort the facet on code changes to pick up new code while preserving storage:

```ts
this.ctx.facets.abort("app", new Error("Rebuilding"));
```

## More Examples

### Multiple Dependencies

```ts
const { mainModule, modules } = await createWorker({
  files: {
    "src/index.ts": `
      import { Hono } from 'hono';
      import { zValidator } from '@hono/zod-validator';
      import { z } from 'zod';

      const app = new Hono();
      const schema = z.object({ name: z.string() });

      app.post('/greet', zValidator('json', schema), (c) => {
        const { name } = c.req.valid('json');
        return c.json({ message: \`Hello, \${name}!\` });
      });

      export default app;
    `,
    "package.json": JSON.stringify({
      dependencies: {
        hono: "^4.0.0",
        "@hono/zod-validator": "^0.4.0",
        zod: "^3.23.0"
      }
    })
  }
});
```

### With Wrangler Config

```ts
const { mainModule, modules, wranglerConfig } = await createWorker({
  files: {
    "src/index.ts": `
      export default {
        fetch: () => new Response('Hello!')
      }
    `,
    "wrangler.toml": `
      main = "src/index.ts"
      compatibility_date = "2026-01-01"
      compatibility_flags = ["nodejs_compat"]
    `
  }
});

const worker = env.LOADER.get("my-worker", () => ({
  mainModule,
  modules,
  compatibilityDate: wranglerConfig?.compatibilityDate ?? "2026-01-01",
  compatibilityFlags: wranglerConfig?.compatibilityFlags
}));
```

### Transform-only Mode

Skip bundling to preserve the module structure:

```ts
const { mainModule, modules } = await createWorker({
  files: {
    /* ... */
  },
  bundle: false
});
```

## Advanced bundler options

`createWorker` and `createApp` cover the common cases (target, minify, sourcemap, externals). The options below are escape hatches for advanced consumers — RSC-style transforms, custom asset pipelines, library bundling.

> **All options in this section require `bundle: true`** (the default). Transform-only mode (`bundle: false`) skips esbuild entirely and uses sucrase + naïve module resolution instead, so `define`, `loader`, `conditions`, plugins, and the JSX options have no effect there. Setting any of them with `bundle: false` adds a warning to `result.warnings` rather than failing silently.

### `jsx`, `jsxImportSource`

Pick a JSX runtime explicitly. With `jsx: "automatic"` you don't need to import React (or whatever runtime) in every file.

```ts
await createApp({
  files,
  client: "src/client.tsx",
  jsx: "automatic",
  jsxImportSource: "react"
});
```

### `define`

Compile-time constant replacement. Each value must be a valid JavaScript expression as a string (so wrap string values in extra quotes).

```ts
await createWorker({
  files,
  define: {
    "process.env.NODE_ENV": '"production"',
    __DEV__: "false",
    __VERSION__: JSON.stringify(pkg.version)
  }
});
```

### `loader`

Tell the bundler how to interpret arbitrary file extensions. The built-in handling for `.ts` / `.tsx` / `.js` / `.jsx` / `.json` / `.css` is preserved unless you override it. Longer extensions match first, so `".d.ts"` wins over `".ts"`.

```ts
await createWorker({
  files,
  loader: {
    ".svg": "text",
    ".wasm": "binary",
    ".sql": "text"
  }
});
```

The supported `BundlerLoader` values are deliberately narrowed to the portable subset that every modern bundler can express:

| Loader    | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `js`      | Plain JavaScript                                           |
| `jsx`     | JSX (transformed per the `jsx` option)                     |
| `ts`      | TypeScript                                                 |
| `tsx`     | TypeScript + JSX                                           |
| `json`    | Parse as JSON, expose as the default export                |
| `css`     | Parse as CSS                                               |
| `text`    | Embed file contents as a UTF-8 string default export       |
| `binary`  | Embed file contents as a `Uint8Array` default export       |
| `base64`  | Embed file contents as a base64 string default export      |
| `dataurl` | Embed file contents as a `data:` URL string default export |

esbuild's `file` / `copy` loaders are intentionally not exposed: they emit secondary output files that this bundler currently discards (only the first output is read). If you need that — or anything else esbuild-specific — reach for `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired` instead.

### `conditions`

Package export conditions, in priority order. Useful when bundling libraries that ship multiple builds via `package.json#exports`.

```ts
await createWorker({
  files,
  conditions: ["workerd", "worker", "browser"]
});
```

### `__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired`

> **Read this before using.** This option is **not** covered by semver. The name is the API contract: it can change shape, be renamed, or be removed in any release. The runtime ties you to esbuild — if this package switches bundlers (e.g. to rolldown), plugins authored against this API will break.

Pass extra esbuild plugins. They run **before** the bundler's internal virtual-filesystem plugin, so a plugin's `onResolve` / `onLoad` claims fire first (e.g. an RSC plugin claiming `"server-function:*"` before virtual-fs tries to read it from disk).

The option is typed as `unknown[]` at the public boundary so the published `.d.ts` doesn't depend on `esbuild-wasm`'s types. Cast your plugin array when passing it in:

```ts
import type { Plugin } from "esbuild-wasm";

const myRscPlugin: Plugin = {
  name: "rsc",
  setup(build) {
    build.onResolve({ filter: /^server-function:/ }, (args) => ({
      path: args.path,
      namespace: "rsc"
    }));
    build.onLoad({ filter: /.*/, namespace: "rsc" }, (args) => ({
      contents: generateServerFunctionStub(args.path),
      loader: "ts"
    }));
  }
};

await createApp({
  files,
  client: "src/client.tsx",
  __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
    myRscPlugin
  ] as unknown[]
});
```

## Worker Loader Setup

```jsonc
// wrangler.jsonc (host worker)
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

```ts
interface Env {
  LOADER: WorkerLoader;
}
```

## File System

The bundler operates on a `FileSystem` interface — a minimal, synchronous abstraction for reading, writing, and listing files. All bundler APIs (`createWorker`, `createApp`) accept either a plain `Record<string, string>` (auto-wrapped in `InMemoryFileSystem`) or any `FileSystem` implementation.

```ts
interface FileSystem {
  read(path: string): string | null;
  write(path: string, content: string): void;
  delete(path: string): void;
  list(prefix?: string): string[];
  flush(): Promise<void>;
}
```

### Implementations

**`InMemoryFileSystem`** — `Map`-backed, no persistence. Accepts a seed object or `Map`:

```ts
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";

const fs = new InMemoryFileSystem({
  "src/index.ts": "export default { fetch() { return new Response('ok'); } };"
});
```

**`DurableObjectKVFileSystem`** — Writes are buffered in memory and flushed to Durable Object KV in one batch. Reads see buffered writes immediately:

```ts
import { DurableObjectKVFileSystem } from "@cloudflare/worker-bundler";

const fs = new DurableObjectKVFileSystem(this.ctx.storage);
fs.write("src/index.ts", code);

const result = await createWorker({ files: fs });

// Persist everything (source + installed node_modules) to KV
await fs.flush();
```

After flushing, the filesystem is durable — a subsequent `createWorker` call on a new `DurableObjectKVFileSystem` over the same storage will find `node_modules` already present and skip installation entirely.

**`DurableObjectRawFileSystem`** — Every write goes directly to KV with no buffering. Use when writing a small number of files where per-write durability is preferred:

```ts
import { DurableObjectRawFileSystem } from "@cloudflare/worker-bundler";

const fs = new DurableObjectRawFileSystem(this.ctx.storage);
```

### Snapshotting from async sources

The `FileSystem` interface is synchronous because esbuild and TypeScript require synchronous file access. To bridge from an async storage backend (like `Workspace` from `@cloudflare/shell`), use `createFileSystemSnapshot`:

```ts
import { createFileSystemSnapshot } from "@cloudflare/worker-bundler";

// Accepts any sync or async iterable of [path, content] pairs
async function* workspaceFiles(workspace) {
  for (const entry of workspace.glob("**/*.{ts,tsx,json}")) {
    const content = await workspace.readFile(entry.path);
    if (content !== null) yield [entry.path, content];
  }
}

const fs = await createFileSystemSnapshot(workspaceFiles(workspace));
const result = await createWorker({ files: fs });
```

## Pre-installing Dependencies

`installDependencies` is exported separately so you can pre-warm a filesystem with npm packages independently of `createWorker`:

```ts
import {
  installDependencies,
  DurableObjectKVFileSystem,
  createWorker
} from "@cloudflare/worker-bundler";

const fs = new DurableObjectKVFileSystem(this.ctx.storage);
fs.write("package.json", JSON.stringify({ dependencies: { hono: "^4.0.0" } }));
fs.write("src/index.ts", code);

// Install once, flush to KV
await installDependencies(fs);
await fs.flush();

// On subsequent requests, createWorker finds node_modules already
// present and skips installation — no network requests
const result = await createWorker({ files: fs });
```

This is useful for separating the install step (slow, network-bound) from the bundle step (fast, CPU-only), and for persisting installed packages across DO restarts.

## TypeScript Language Service

A full TypeScript language service runs in-process inside the Workers runtime. Import it from the `./typescript` subpath to keep the TypeScript bundle (~5 MB) out of the main entry:

```ts
import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";

const fileSystem = new InMemoryFileSystem({
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      lib: ["es2024"],
      target: "ES2024",
      module: "ES2022",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true
    }
  }),
  "src/index.ts": `
    const worker: ExportedHandler = {
      async fetch() {
        return new Response("Hello, world!");
      }
    };
    export default worker;
  `
});

const { fileSystem: tsFileSystem, languageService } =
  await createTypescriptLanguageService({ fileSystem });

// Get diagnostics
const errors = languageService.getSemanticDiagnostics("src/index.ts");
```

The returned `fileSystem` wraps the original and keeps the TypeScript environment in sync — write through it to see updated diagnostics immediately:

```ts
// Fix an error
tsFileSystem.write("src/index.ts", correctedCode);

// Diagnostics now reflect the fix
const errors = languageService.getSemanticDiagnostics("src/index.ts");
// => []
```

### With `installDependencies`

Install type packages into the filesystem before creating the language service to get full type coverage:

```ts
import {
  installDependencies,
  InMemoryFileSystem
} from "@cloudflare/worker-bundler";
import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";

const fs = new InMemoryFileSystem({
  "package.json": JSON.stringify({
    dependencies: { "@cloudflare/workers-types": "^4.20260405.1" }
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      lib: ["es2024"],
      strict: true,
      skipLibCheck: true,
      types: ["@cloudflare/workers-types/index.d.ts"]
    }
  }),
  "src/index.ts": workerSource
});

await installDependencies(fs);

const { languageService } = await createTypescriptLanguageService({
  fileSystem: fs
});
const diagnostics = languageService.getSemanticDiagnostics("src/index.ts");
```

### Integrating with Workspace

When using `Workspace` from `@cloudflare/shell` as durable storage, snapshot source files into an `InMemoryFileSystem` for type checking:

```ts
import { createFileSystemSnapshot } from "@cloudflare/worker-bundler";
import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";

// 1. Snapshot source files from Workspace (async reads)
async function* sourceFiles(workspace) {
  for (const entry of workspace.glob("**/*.{ts,tsx,json}")) {
    const content = await workspace.readFile(entry.path);
    if (content !== null) yield [entry.path, content];
  }
}

const fs = await createFileSystemSnapshot(sourceFiles(workspace));

// 2. Create language service (synchronous reads during init)
const { fileSystem, languageService } = await createTypescriptLanguageService({
  fileSystem: fs
});

// 3. Get diagnostics
const errors = languageService.getSemanticDiagnostics("src/index.ts");

// 4. On edits, update both the TS environment and durable storage
fileSystem.write("src/index.ts", newContent);
await workspace.writeFile("src/index.ts", newContent);
```

## Known Limitations

- **Flat node_modules** — All packages are installed into a single flat directory. If two packages need different incompatible versions of the same transitive dependency, only one version is installed.
- **Long file paths in tarballs** — The tar parser handles classic headers but not POSIX extended (PAX) headers. Packages with paths longer than 100 characters may have those files silently truncated.
- **Text files only from npm** — Only text files (`.js`, `.json`, `.css`, etc.) are extracted from tarballs. Binary files like `.wasm` or `.node` are skipped.
- **No recursion depth limit** — Transitive dependency resolution has no depth limit. A pathological dependency tree could cause excessive network requests.
- **TypeScript lib declarations fetched at runtime** — `createTypescriptLanguageService` downloads the TypeScript npm tarball (~23 MB) on every call to extract the standard library `.d.ts` files (~3.7 MB). There is no caching — each cold start of a Durable Object that creates a language service incurs this fetch. A future improvement would pre-bundle these declarations at build time (following the same pattern as the TypeScript compiler bundle).

## License

MIT
