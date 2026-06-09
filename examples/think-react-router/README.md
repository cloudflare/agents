# Think React Router

This example shows how to embed the Think framework inside a React Router app.
React Router owns the document routes, loaders, and SSR, while Think discovers
agents from the `agents/` directory and handles `/api/agents/*` requests.

## Run

```bash
npm install
npm start
```

Open the local Vite URL and visit:

- `/` for a React Router loader route.
- `/host` for a React Router loader that reads `context.cloudflare`.
- `/api/agents/host/<room>` for the generated Think agent WebSocket route.

Run the example's e2e check with:

```bash
npm run test:e2e
```

Regenerate the Think virtual module and typed Env declarations with:

```bash
npm exec -- think types
```

Use `npm exec -- think types --all -- <wrangler types flags>` when you also
want to refresh Wrangler's platform declarations.

## Key Pattern

Use the Cloudflare Vite plugin for React Router's SSR environment, then add the
Think plugin:

```ts
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
  ]
});
```

Keep React Router's Vite Environment API flag enabled so both dev and production
builds use the Cloudflare-backed SSR environment:

```ts
export default {
  appDirectory: "app",
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true
  }
} satisfies Config;
```

The Worker entry is a tiny shim that re-exports Think's generated entry so
generated Durable Object classes stay on the Worker module:

```ts
export { default } from "virtual:think/entry";
export * from "virtual:think/entry";
```

The app server delegates normal requests to React Router and returns `null` for
Think-owned routes so the generated Think entry can handle them.

## Current Rough Edges

This example intentionally keeps the integration explicit. The shape works today
and proves that Think composes with React Router in workerd, but a few pieces
should become nicer before this becomes the final framework ergonomics:

- `allowNonVirtualMain: true` is an escape hatch for the filesystem Worker shim.
  A future host-framework mode can make this implicit.
- `src/worker.ts` only re-exports `virtual:think/entry`. This is simple, but it
  is still boilerplate that a CLI or framework adapter could generate.
- `src/server.ts` manually checks `/api/agents/*` and returns `null` so Think can
  handle those routes. A small helper such as `think.router.owns(request)` may be
  useful once we compare this against another host framework.
- The React Router `server-build` import handles both module shapes with
  `(mod.default ?? mod)`. A React Router adapter helper could hide that detail.

These do not block the next framework work. They are good candidates to revisit
after trying a second host framework, or when the CLI/type generation pass starts.
