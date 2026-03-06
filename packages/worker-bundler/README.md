# worker-bundler

Bundle source files for Cloudflare's [Worker Loader binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) (closed beta). Perfect for AI coding agents that need to dynamically generate and deploy javascript code with real npm dependencies.

## Installation

```
npm install @cloudflare/worker-bundler
```

## Quick Start

Just provide your source code and dependencies — no config files needed:

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

The library automatically:

- Detects your entry point (`src/index.ts` by default)
- Fetches and installs npm dependencies from the registry
- Bundles everything with esbuild
- Returns modules ready for the Worker Loader binding

## API

### `createWorker(options)`

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

### Returns

```ts
{
  mainModule: string;        // Entry point path
  modules: Record<string, string>;  // All output modules
  wranglerConfig?: {         // Parsed from wrangler.toml/json/jsonc
    main?: string;
    compatibilityDate?: string;
    compatibilityFlags?: string[];
  };
  warnings?: string[];       // Any warnings during bundling
}
```

### Entry Point Detection

Priority order:

1. `entryPoint` option
2. `main` field in wrangler config
3. `exports`, `module`, or `main` field in package.json
4. Default paths: `src/index.ts`, `src/index.js`, `index.ts`, `index.js`

## More Examples

### Multiple Dependencies

```ts
const worker = env.LOADER.get("my-worker", async () => {
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

  return { mainModule, modules, compatibilityDate: "2026-01-01" };
});
```

### With Wrangler Config

For projects that need specific compatibility settings or are migrating from existing Workers:

```ts
const worker = env.LOADER.get("my-worker", async () => {
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

  return {
    mainModule,
    modules,
    compatibilityDate: wranglerConfig?.compatibilityDate ?? "2026-01-01",
    compatibilityFlags: wranglerConfig?.compatibilityFlags
  };
});
```

### Transform-only Mode

Skip bundling to preserve module structure:

```ts
const worker = env.LOADER.get("my-worker", async () => {
  const { mainModule, modules } = await createWorker({
    files: {
      /* ... */
    },
    bundle: false
  });

  return { mainModule, modules, compatibilityDate: "2026-01-01" };
});
```

## Worker Loader Setup

```toml
# wrangler.toml (host worker)
[[worker_loaders]]
binding = "LOADER"
```

```ts
interface Env {
  LOADER: WorkerLoader;
}
```

## Known Limitations

- **Flat node_modules** — All packages are installed into a single flat `node_modules/` directory. If two packages depend on different incompatible versions of the same transitive dependency, only one version is installed. This works for most dependency trees in practice.
- **Long file paths in tarballs** — The tar parser handles classic tar headers but not POSIX extended (PAX) headers. Packages with file paths longer than 100 characters may have those files silently truncated or missing.
- **Text files only from npm** — Only text files (`.js`, `.json`, `.css`, etc.) are extracted from npm tarballs. Binary files like `.wasm` or `.node` are skipped. If a dependency ships binary assets needed at runtime, they won't be available.
- **No recursion depth limit** — Transitive dependency installation has no depth limit. A pathological dependency tree could cause excessive network requests and memory usage.

## Future Work

- Lockfile support: Read `package-lock.json` / `pnpm-lock.yaml` for deterministic installs
- Binary file support: Extract `.wasm` and other binary assets from npm packages
- Nested `node_modules`: Support multiple versions of the same package for diamond dependencies

## License

MIT
