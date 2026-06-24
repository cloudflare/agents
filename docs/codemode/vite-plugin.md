# Vite Plugin

The `@cloudflare/codemode/vite` plugin exports the `CodemodeRuntime` facet class from your Worker entry module.

**Why this exists:** `createCodemodeRuntime()` stores execution state in a Durable Object facet. The Workers runtime requires facet classes to be available through `ctx.exports`, so the Worker entry module must export `CodemodeRuntime`. The plugin adds that export for you.

Connector classes do not need special import syntax. Import them normally and pass instances to `createCodemodeRuntime()`.

## Setup

```ts
// vite.config.ts
import codemode from "@cloudflare/codemode/vite";
import agents from "agents/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default {
  plugins: [agents(), codemode(), cloudflare()]
};
```

## What it does

For Worker entry modules (`src/server.ts`, `src/index.ts`, or `src/worker.ts`), the plugin appends:

```ts
// Auto-exported by @cloudflare/codemode/vite
export { CodemodeRuntime } from "@cloudflare/codemode";
```

That makes `CodemodeRuntime` available as `ctx.exports.CodemodeRuntime`, which the runtime handle uses when it creates its facet.

If your entry module already exports `CodemodeRuntime`, the plugin leaves it unchanged.

## Connector imports

Use normal TypeScript imports:

```ts
import { GithubConnector } from "./github.codemode";
import { RepoApiConnector } from "./repoapi.codemode";
```

Then construct connector instances where you create the runtime:

```ts
const runtime = createCodemodeRuntime({
  ctx: this.ctx,
  executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
  connectors: [new GithubConnector(this.ctx, this.env, conn)]
});
```

## Manual alternative

If you do not use the plugin, export `CodemodeRuntime` yourself from the Worker entry module:

```ts
export { CodemodeRuntime } from "@cloudflare/codemode";
```
