# Dynamic Workers

Demonstrates [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) — spin up sandboxed, disposable isolates at runtime from a host Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/dynamic-workers)

## Get started

```sh
npm install   # from the repo root
npm start     # from this directory
```

## How it works

The host Worker exposes a `/api/run` endpoint. The React frontend sends user-written code to it, and the server loads it into a one-off dynamic isolate:

```ts
const worker = env.LOADER.load({
  compatibilityDate: "2026-01-28",
  mainModule: "worker.js",
  modules: {
    "worker.js": code
  },
  globalOutbound: null
});

const result = await worker
  .getEntrypoint()
  .fetch(new Request("https://worker/"));
```

- `LOADER.load()` — creates a one-off dynamic isolate
- `globalOutbound: null` — blocks all outbound network access from the dynamic Worker

## Learn more

- [Dynamic Worker Loaders docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
