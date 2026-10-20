# `@cloudflare/codemode`

`WorkerJavaScriptBackend` runs JavaScript in a fresh [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/). The code is an ES module. It reads and writes files through `node:fs` and imports host modules (`ws:*`) whose functions run in your Durable Object. It has no network access unless you allow it.

[`@cloudflare/computer`](https://github.com/cloudflare/computer) runs Workspace code on this backend. Use Computer if you want a model-facing `exec` tool, a SQLite-backed filesystem and the agent's tools as `ws:tools`. Use this package to run code against your own storage and host functions.

## Installation

```sh
npm install @cloudflare/codemode
```

Add a Worker Loader binding to `wrangler.jsonc`:

```jsonc
{ "worker_loaders": [{ "binding": "LOADER" }] }
```

## Usage

```ts
import { WorkerJavaScriptBackend } from "@cloudflare/codemode";

const backend = new WorkerJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "ws:weather": {
      forecast: async ([city]) => lookUpForecast(String(city))
    }
  }
});

// In a Durable Object: SQLite for execution records, and the files code sees.
const handle = await backend.connect({ db, fs });

const execution = await handle.exec({
  source: `
    import { forecast } from "ws:weather";
    export default async ({ city }) => forecast(city);
  `,
  input: { city: "Lisbon" }
});

for await (const event of execution.events) {
  // stdout and stderr chunks, then { name: "exit", code, result }
}
```

`db` is a small SQLite interface over `ctx.storage.sql`, and `fs` implements `WorkspaceRuntimeFilesystem`. See [`WorkerJavaScriptBackend`](https://github.com/cloudflare/agents/blob/main/docs/codemode/worker-javascript.md) for both, plus module factories, limits and network access.

## Legacy Code Mode API

Every other export (`createCodeTool`, `DynamicWorkerExecutor`, connectors, `createCodemodeRuntime`, `codeMcpServer`, `IframeSandboxExecutor`, the Vite plugin and the utilities) is the original Code Mode API. It is feature-frozen: it keeps working from the same import paths and won't change, but it is no longer maintained. Every export is marked `@deprecated`.

The code lives in [`src/legacy`](https://github.com/cloudflare/agents/tree/main/packages/codemode/src/legacy) so you can copy it into your project. See [The legacy Code Mode API](https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md) for what replaces each piece.

The published package includes the guides under `docs/`.

## License

MIT
