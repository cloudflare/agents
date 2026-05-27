# Think TanStack Start

This example shows how to embed the Think framework inside a TanStack Start app.
TanStack Start owns the document routes, loaders, and SSR, while Think discovers
agents from the `agents/` directory and handles `/api/agents/*` requests.

## Run

```bash
npm install
npm start
```

Open the local Vite URL and visit:

- `/` for a TanStack Start loader route.
- `/host` for a TanStack Start loader that reads Cloudflare bindings.
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

Use the Cloudflare Vite plugin for TanStack Start's SSR environment, then add the
TanStack Start, React, and Think plugins:

```ts
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
  ]
});
```

The Worker entry is a tiny shim that re-exports Think's generated entry so
generated Durable Object classes stay on the Worker module:

```ts
export { default } from "virtual:think/entry";
export * from "virtual:think/entry";
```

The app server delegates normal requests to TanStack Start and returns `null`
for Think-owned routes so the generated Think entry can handle them:

```ts
import handler from "@tanstack/react-start/server-entry";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/agents/")) {
      return null;
    }

    return handler.fetch(request, env, ctx);
  }
};
```

## Current Rough Edges

This example intentionally keeps the integration explicit. The shape matches the
React Router host example closely, which suggests a future host-framework helper
can smooth over the repeated pieces:

- `allowNonVirtualMain: true` is an escape hatch for the filesystem Worker shim.
- `src/worker.ts` only re-exports `virtual:think/entry`.
- `src/server.ts` manually checks `/api/agents/*` and returns `null` so Think can
  handle those routes.

TanStack Start also recommends disabling `verbatimModuleSyntax`, so this example
overrides that setting from the repo's base TypeScript config.
