# worker-bundler

> **Experimental**: This package is under active development and its API may change without notice. Not recommended for production use.

Bundle and serve full-stack applications on Cloudflare's [Worker Loader binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) (closed beta). Dynamically generate Workers with real npm dependencies, or build complete apps with client-side bundles and static asset serving.

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

Use `createApp` to bundle a server Worker, client-side JavaScript, and static assets together:

```ts
import { createApp } from "@cloudflare/worker-bundler";

const worker = env.LOADER.get("my-app", async () => {
  const { mainModule, modules } = await createApp({
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
      `,
      "package.json": JSON.stringify({
        dependencies: {
          /* ... */
        }
      })
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

  return { mainModule, modules, compatibilityDate: "2026-01-01" };
});
```

The generated Worker automatically serves static assets (with proper content types, ETags, and caching) and falls through to your server code for API routes.

## API

### `createWorker(options)`

Bundles source files into a Worker.

| Option       | Type                     | Default                        | Description                                                       |
| ------------ | ------------------------ | ------------------------------ | ----------------------------------------------------------------- |
| `files`      | `Record<string, string>` | _required_                     | Input files (path → content)                                      |
| `entryPoint` | `string`                 | auto-detected                  | Entry point file path                                             |
| `bundle`     | `boolean`                | `true`                         | Bundle all dependencies into one file                             |
| `externals`  | `string[]`               | `[]`                           | Modules to exclude from bundling (`cloudflare:*` always external) |
| `target`     | `string`                 | `'es2022'`                     | Target environment                                                |
| `minify`     | `boolean`                | `false`                        | Minify output                                                     |
| `sourcemap`  | `boolean`                | `false`                        | Generate inline source maps                                       |
| `registry`   | `string`                 | `'https://registry.npmjs.org'` | npm registry URL                                                  |

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

| Option          | Type                                    | Default       | Description                                     |
| --------------- | --------------------------------------- | ------------- | ----------------------------------------------- |
| `files`         | `Record<string, string>`                | _required_    | All source files (server + client)              |
| `server`        | `string`                                | auto-detected | Server entry point (Worker fetch handler)       |
| `client`        | `string \| string[]`                    | —             | Client entry point(s) to bundle for the browser |
| `assets`        | `Record<string, string \| ArrayBuffer>` | —             | Static assets (pathname → content)              |
| `assetConfig`   | `AssetConfig`                           | —             | Asset serving configuration                     |
| `bundle`        | `boolean`                               | `true`        | Bundle server dependencies                      |
| `externals`     | `string[]`                              | `[]`          | Modules to exclude from bundling                |
| `target`        | `string`                                | `'es2022'`    | Server target environment                       |
| `minify`        | `boolean`                               | `false`       | Minify output                                   |
| `sourcemap`     | `boolean`                               | `false`       | Generate source maps                            |
| `registry`      | `string`                                | npm default   | npm registry URL                                |
| `durableObject` | `boolean \| { className?: string }`     | —             | Generate a Durable Object class wrapper         |

Returns everything from `createWorker` plus:

```ts
{
  assetManifest: AssetManifest;        // Metadata (content types, ETags) per asset
  assetConfig?: AssetConfig;           // The asset config used
  clientBundles?: string[];            // Output paths of client bundles
  durableObjectClassName?: string;     // DO class name (when durableObject option used)
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
import type { Workspace } from "agents/experimental/workspace";

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

## Durable Object Mode

Pass `durableObject: true` to generate a Durable Object class wrapper instead of a module worker. This gives generated apps persistent storage via `this.ctx.storage` — state survives across requests, code rebuilds, and isolate restarts.

```ts
const result = await createApp({
  files: {
    "src/server.ts": `
      import { DurableObject } from 'cloudflare:workers';

      export default class App extends DurableObject {
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
  },
  durableObject: true
});
```

The wrapper exports a named class (default `"App"`) that:

- Serves static assets first (same behavior as module worker mode)
- Falls through to the user's `fetch()` via `super.fetch(request)`
- If the user exports a class, the wrapper extends it (so `this.ctx.storage` works)
- If the user exports a plain `{ fetch }` handler, the wrapper wraps it in a DO

### Using with `ctx.facets`

The host Durable Object loads the worker via LOADER and creates a facet:

```ts
const worker = env.LOADER.get(loaderId, () => ({
  mainModule: result.mainModule,
  modules: result.modules,
  compatibilityDate: "2026-01-28"
}));

const className = result.durableObjectClassName; // "App"
const facet = this.ctx.facets.get("app", () => ({
  class: worker.getDurableObjectClass(className),
  id: "app"
}));

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

## Known Limitations

- **Flat node_modules** — All packages are installed into a single flat directory. If two packages need different incompatible versions of the same transitive dependency, only one version is installed.
- **Long file paths in tarballs** — The tar parser handles classic headers but not POSIX extended (PAX) headers. Packages with paths longer than 100 characters may have those files silently truncated.
- **Text files only from npm** — Only text files (`.js`, `.json`, `.css`, etc.) are extracted from tarballs. Binary files like `.wasm` or `.node` are skipped.
- **No recursion depth limit** — Transitive dependency resolution has no depth limit. A pathological dependency tree could cause excessive network requests.

## License

MIT
