# Run Playground

Execute untrusted JavaScript and TypeScript in a fresh, isolated
[Dynamic Worker](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
per run with [`@cloudflare/run`](../../packages/run) — no bindings, no
imports, no network, and no authority beyond the host functions the server
passes in.

## Get started

```sh
pnpm install   # from the repo root
pnpm start     # from this directory
```

Dynamic Workers require a [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
plan when deployed; local development works on any account.

## What it demonstrates

- **One `run()` call** — the server exposes `POST /api/run`, which executes
  the submitted source with `@cloudflare/run` and returns the value, the
  captured console output, and the server-measured duration.
- **Explicit authority** — the sandboxed code can only reach the
  `demo.customers()` and `demo.wait(ms)` host functions defined in
  `src/server.ts`. The host functions run in the parent Worker;
  `getHostFunctionContext().signal` makes `demo.wait` cancellation-aware.
- **Fresh isolate per run** — the "Fresh isolate" preset mutates
  `globalThis` and returns a counter that can never exceed 1. A latency card
  tracks the median/p95 cost of paying for that freshness on every run.
- **"Try to break it" presets** — hostile snippets (reach the network,
  import a module, burn CPU, flood the logs, sleep past the timeout, throw
  deep in a call) each come back as a clean, typed `RunError` code instead
  of an incident.
- **Source-line stacks** — runtime error stacks point at the submitted
  source's own line numbers; clicking a frame jumps the editor to that line.
- **Tunable limits** — `timeoutMs`, `cpuMs`, and `maxLogBytes` are wired to
  inputs, so out-of-range values demonstrate `RUN_INVALID_INPUT` too.

## The key pattern

```ts
import { getHostFunctionContext, run, RunError } from "@cloudflare/run";

const result = await run({
  loader: env.LOADER,
  source, // untrusted code — the body of an async function
  limits: { timeoutMs, cpuMs, maxLogBytes },
  hostFunctions: {
    demo: {
      async customers() {
        return CUSTOMERS; // runs in *this* Worker, with your bindings
      }
    }
  }
});
// result.value, result.logs — or a thrown RunError with a stable .code
```

The Worker Loader binding comes from `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

## Local dev notes

- The workerd bundled for local dev rejects child compatibility dates newer
  than its own build, so `src/server.ts` clamps the child's date to this
  example's own `compatibility_date` during `vite dev` only. Deployed
  Workers use the package's pinned child date unchanged.
- Local dev does not enforce the `cpuMs` budget — the "Burn CPU" preset
  completes locally after a few seconds, while a deployed Worker kills it
  with `RUN_RESOURCE_LIMIT`. Never feed a true `while (true) {}` to local
  dev: without CPU enforcement it will hang the dev server.

## Related examples

- [`dynamic-workers-playground`](../dynamic-workers-playground) — bundling
  and running full Workers (with modules and bindings) at runtime.
- [`codemode`](../codemode) — agent-generated code against tool bindings.
