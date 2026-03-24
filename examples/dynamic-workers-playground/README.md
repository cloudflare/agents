# Dynamic Workers Playground

Write, bundle, and run Cloudflare Worker code at runtime using [`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler) and [Dynamic Worker Loaders](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/dynamic-workers-playground)

## Get started

```sh
npm install   # from the repo root
npm start     # from this directory
```

## What it demonstrates

**Server-side**

- Runtime bundling with `@cloudflare/worker-bundler` — resolves npm deps and bundles source files inside a Worker
- Dynamic execution via a `worker_loaders` binding, with automatic caching when source hasn't changed
- Log capture pipeline — a Tail Worker (`DynamicWorkerTail`) forwards `console.*` output from dynamically loaded workers to a Durable Object (`LogSession`), streamed back to the caller in real time
- Execution timing — granular build/load/run breakdown with cold vs. warm start detection

**Client-side**

- Tabbed file editor with Tab-key indentation support
- Load built-in example workers or import any public GitHub repo
- Bundle/minify toggles passed through to `worker-bundler`
- Real-time output: response body, console logs, timing, and bundle info

## How it works

When you click **Run Worker**, the host Worker receives your source files and calls `createWorker()` from `@cloudflare/worker-bundler` to bundle them at runtime:

```ts
const { mainModule, modules, wranglerConfig, warnings } = await createWorker({
  files: normalizedFiles,
  bundle: options?.bundle ?? true,
  minify: options?.minify ?? false
});

const worker = env.LOADER.get(workerId, async () => ({
  mainModule,
  modules,
  tails: [contextExports.DynamicWorkerTail({ props: { workerId } })]
}));

const response = await worker.getEntrypoint().fetch(request);
```

Console logs from the dynamic worker are captured by `DynamicWorkerTail` (a Tail Worker) and routed through a `LogSession` Durable Object back to the HTTP response.

## Learn more

- [Dynamic Worker Loaders docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [`@cloudflare/worker-bundler` on npm](https://www.npmjs.com/package/@cloudflare/worker-bundler)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
