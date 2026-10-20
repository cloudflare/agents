# `WorkerJavaScriptBackend`

`WorkerJavaScriptBackend` runs an ECMAScript module in a fresh [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/). The code reads and writes files through `node:fs`, and imports host modules (`ws:*`) whose functions run in your Durable Object. Network access is off unless you turn it on.

It is the JavaScript backend of [`@cloudflare/computer`](https://github.com/cloudflare/computer). Computer depends on this package, and a Computer `Workspace` connects the backend for you. This page covers using it on its own. For a model-facing `exec` tool, Workspace files, sync and Git, use Computer.

## Connect it to a host

A backend runs nothing until it connects. `connect()` takes the two things the backend needs from your Durable Object:

- `db`: SQLite for execution records and their output. The backend creates tables named `workspace_runtime_*`.
- `fs`: the files code sees through `node:fs`, as a `WorkspaceRuntimeFilesystem`. This package doesn't ship one. Implement the interface over your own storage, or use a Computer `Workspace`, which brings a SQLite-backed filesystem.

```ts
import { DurableObject } from "cloudflare:workers";
import {
  WorkerJavaScriptBackend,
  type WorkspaceRuntimeDatabase
} from "@cloudflare/codemode";

export class Runner extends DurableObject<Env> {
  #handle = new WorkerJavaScriptBackend({
    loader: this.env.LOADER,
    modules: {
      "ws:weather": {
        forecast: async ([city]) => lookUpForecast(String(city))
      }
    }
  }).connect({ db: sqlDatabase(this.ctx.storage), fs: myFilesystem });

  async run(source: string) {
    const handle = await this.#handle;
    const execution = await handle.exec({ source, input: { city: "Lisbon" } });
    for await (const event of execution.events) {
      // { name: "stdout" | "stderr", value: Uint8Array }
      // { name: "exit", code, result? }
    }
  }
}

// ctx.storage.sql returns BLOB columns as ArrayBuffer; the backend wants
// Uint8Array.
function sqlDatabase(storage: DurableObjectStorage): WorkspaceRuntimeDatabase {
  function all<Row extends object>(
    query: string,
    ...bindings: unknown[]
  ): Row[] {
    return storage.sql
      .exec(query, ...bindings)
      .toArray()
      .map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] =
            value instanceof ArrayBuffer ? new Uint8Array(value) : value;
        }
        return out as Row;
      });
  }
  return {
    run: (query, ...bindings) => void storage.sql.exec(query, ...bindings),
    all,
    one<Row extends object>(query: string, ...bindings: unknown[]) {
      return all<Row>(query, ...bindings)[0];
    },
    transactionSync: (closure) => storage.transactionSync(closure)
  };
}
```

`wrangler.jsonc` needs a Worker Loader binding:

```jsonc
{ "worker_loaders": [{ "binding": "LOADER" }] }
```

Connect once per Durable Object and reuse the handle. Connecting marks any execution that was still running in SQLite as failed, since its Dynamic Worker is gone.

## What the code looks like

The source is an ES module. Its default export is called with `input`, and what it returns is the result:

```js
import { readFile } from "node:fs/promises";
import { forecast } from "ws:weather";

export default async function ({ city }) {
  const notes = await readFile("/workspace/notes.txt", "utf8");
  return { notes, forecast: await forecast(city) };
}
```

`node:fs` and host module calls only work inside the default export. The Workers runtime allows no I/O while a module loads, and a call made then fails the run. Results and host module arguments must be JSON-compatible plain data.

Every path is confined to `root` (`/workspace` by default). A read-write backend creates `root` on its first run.

## Modules

The `modules` option maps a specifier to one of three things:

- A string of JavaScript, bundled into the isolate: `"tar-stream": TAR_STREAM_BUNDLE`.
- An object of functions, a host module. Each function runs in your Durable Object and gets the code's arguments as an array plus a context with `signal`, `deadline`, `access` and `resolvePath`.
- A factory that builds the functions when the backend connects. It receives every field you passed to `connect()` except `db` and `fs`, so a module can use services that only exist at connect time:

```ts
const backend = new WorkerJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "ws:greeter": ({ greeting }: { greeting: string }) => ({
      greet: ([name]) => `${greeting}, ${String(name)}`
    })
  }
});

await backend.connect({ db, fs, greeting: "Hello" }); // `greeting` is required
```

Computer's prebuilt modules (`ws:git`, `ws:tools`, `ws:artifacts`) are factories of this kind. A Workspace passes its Git client, Artifacts client and runtime when it connects.

Host modules must use a `ws:*` specifier. `backend.description` lists every module for a model, including each factory's `description`.

## Limits

Each run has a timeout (`defaultTimeoutMs`, capped by `maxTimeoutMs`), a CPU limit (`maxCpuMs`), and byte limits on source, input, output, results and host calls. Finished runs stay in SQLite for 60 minutes, up to 100 of them, so `handle.getExec({ id })` can replay their events. Every option is documented on `WorkerJavaScriptBackendOptions`.

Code has no network access by default. Pass `egress: { mode: "direct" }` to allow it, or `egress: { mode: "http-gateway", gateway }` to send every request through a Fetcher you control.
