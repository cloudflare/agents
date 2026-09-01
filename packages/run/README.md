# @cloudflare/run

Run untrusted JavaScript — or a narrow, type-stripped TypeScript subset — in a
fresh, isolated [Cloudflare Dynamic Worker](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
per invocation. Generated code gets no bindings, no modules, and no network;
its only authority is the exact host functions you pass in.

```ts
const result = await run<number>({
  loader: env.LOADER,
  source: "return 20 + 22;"
});
// result.value === 42
```

## Requirements

- **Cloudflare Workers only.** There is no Node.js, Bun, browser, or container
  fallback.
- **A Worker Loader binding.** Dynamic Workers currently require a
  [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
  plan; each invocation loads a fresh Dynamic Worker, so consult current
  Dynamic Workers pricing when executing many distinct programs.
- **`nodejs_compat`** on the calling Worker (Run uses `AsyncLocalStorage` for
  invocation-scoped host-function context).

## Installation

```sh
npm install @cloudflare/run
```

Configure the calling Worker with a Worker Loader binding in `wrangler.jsonc`:

```jsonc
{
  "compatibility_date": "2026-06-11",
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

Your compatibility date stays yours; Run pins the generated child Worker's
configuration itself.

## Quick start

```ts
import { run } from "@cloudflare/run";

interface Env {
  LOADER: WorkerLoader;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await run<number>({
      loader: env.LOADER,
      source: `
interface Pair { left: number; right: number }
const pair: Pair = { left: 20, right: 22 };
console.log("adding", pair.left, pair.right);
return pair.left + pair.right satisfies number;
`
    });

    return Response.json(result);
  }
};
```

A completed run resolves to:

```ts
{
  status: "completed",
  value: 42,
  logs: [{ level: "log", message: "adding 20 22" }]
}
```

`logs` is the ordered console output captured inside the child — all five
console levels, formatted child-side. Raw console arguments never cross the
process boundary, and nothing is written to your Worker's console.

## Host functions and cancellation

Generated code receives authority only through `hostFunctions`: exact,
namespaced functions that run in _your_ Worker with your bindings. Inside a
host function, `getHostFunctionContext()` exposes a signal that aborts when
the run terminates early — pass it to your own async work.

```ts
import { getHostFunctionContext, run, RunError } from "@cloudflare/run";

const result = await run<{ id: string; name: string }>({
  loader: env.LOADER,
  source: `
const user = await users.find("123");
return user;
`,
  hostFunctions: {
    users: {
      async find(id: string) {
        const { signal } = getHostFunctionContext();
        const response = await fetch(`https://example.com/users/${id}`, {
          signal
        });
        return response.json();
      }
    }
  },
  signal: request.signal
}).catch((error: unknown) => {
  if (error instanceof RunError) {
    console.error(error.code, error.logs);
  }
  throw error;
});
```

The host performs the network operation; generated code cannot `fetch`
directly. Host calls are lazy — a call the generated code never awaits or
observes is never dispatched — and returning while an observed call is still
unsettled fails the run with `RUN_DETACHED_HOST_FUNCTION`.

**Cancellation stops the current invocation. It does not reverse a host-side
effect that already completed.**

## The source contract

`source` is strictly the body of an async function. Run places exactly one
generated wrapper line before your source (which is why runtime stacks point
at your own line numbers), so:

- top-level `await` and top-level `return` are valid;
- falling through (or an empty string) completes with `undefined`;
- a bare expression is evaluated but **not** implicitly returned;
- there is no Markdown-fence cleanup, LLM-output normalization, or automatic
  return insertion — malformed source rejects with `RUN_COMPILE_ERROR`.

Runtime errors carry stacks pointing at your submitted source lines.

### TypeScript

Run strips types and guarantees only this erasable subset: type annotations,
interfaces, type aliases, generics, `as` assertions, and `satisfies`
expressions. Enums, constructor parameter properties, namespaces, JSX/TSX,
and type-_checking_ are unsupported and carry no compatibility promise.

### Imports

Static imports, `import type`, and dynamic `import()` reject with
`RUN_COMPILE_ERROR` before any Worker is loaded. The child receives no caller
modules, sees none of your bindings, and has outbound network access disabled
(`globalOutbound: null`).

## Data

Host arguments, host results, and the final result travel over Workers RPC as
ordinary data: `null`, booleans, strings, numbers (including `NaN`,
infinities, and `-0`), `undefined`, `BigInt`, plain objects, arrays
(including sparse), `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`,
`DataView`, and typed arrays. Cycles and repeated references within one graph
are preserved.

Everything else rejects with `RUN_SERIALIZATION_ERROR` instead of being
silently dropped: functions, symbols, promises, streams, `Request`/`Response`,
RPC stubs and other live capabilities, custom class instances, accessors, and
`Error` values used as data (return an explicit `{ name, message }` record
instead).

Workers RPC enforces a ~32 MiB ceiling on each complete serialized message.
Run does not expose payload-size options and does not promise a value near the
ceiling will fit; a platform rejection maps to `RUN_SERIALIZATION_ERROR`.

## Failures

`run()` rejects with a `RunError` carrying a stable machine-readable `code`,
bounded privacy-safe `details`, and the captured `logs`:

| `RunError.code`              | Meaning                                           |
| ---------------------------- | ------------------------------------------------- |
| `RUN_ABORTED`                | The caller's `signal` aborted the invocation.     |
| `RUN_TIMEOUT`                | The wall timeout elapsed.                         |
| `RUN_INVALID_INPUT`          | Options, host functions, or limits are malformed. |
| `RUN_SOURCE_TOO_LARGE`       | Source exceeds `maxSourceBytes`.                  |
| `RUN_COMPILE_ERROR`          | Malformed source or a prohibited import.          |
| `RUN_EXECUTION_ERROR`        | Generated code threw.                             |
| `RUN_HOST_FUNCTION_ERROR`    | A host function threw or rejected.                |
| `RUN_HOST_FUNCTION_LIMIT`    | A host-call limit was exceeded.                   |
| `RUN_DETACHED_HOST_FUNCTION` | Code returned with an observed call unsettled.    |
| `RUN_SERIALIZATION_ERROR`    | A transferred value was rejected.                 |
| `RUN_RESOURCE_LIMIT`         | The child exceeded its CPU or subrequest budget.  |
| `RUN_WORKER_ERROR`           | The Loader or child Worker failed.                |

Generated code sees only a generic message when a host function fails; the
original host error reaches only you, as `RunError.cause`. When the child is
terminated hard (for example a CPU-limit kill or a failed terminal transfer),
`RunError.logs` is best-effort and may be empty.

### Handling failures

Switch on the stable `code` — the union is exhaustive, so the compiler tells
you when a new code appears:

```ts
import { RunError } from "@cloudflare/run";

function describeRunFailure(error: unknown): string {
  if (!(error instanceof RunError)) throw error;
  switch (error.code) {
    case "RUN_TIMEOUT":
    case "RUN_ABORTED":
      return "stopped";
    case "RUN_COMPILE_ERROR":
    case "RUN_EXECUTION_ERROR":
      return "code failed";
    case "RUN_INVALID_INPUT":
    case "RUN_SOURCE_TOO_LARGE":
    case "RUN_HOST_FUNCTION_ERROR":
    case "RUN_HOST_FUNCTION_LIMIT":
    case "RUN_DETACHED_HOST_FUNCTION":
    case "RUN_SERIALIZATION_ERROR":
    case "RUN_RESOURCE_LIMIT":
    case "RUN_WORKER_ERROR":
      return error.code;
    default:
      return error.code satisfies never;
  }
}
```

## Limits

All limits are optional overrides on `options.limits`; each must be a finite
positive safe integer within its range, or the run rejects with
`RUN_INVALID_INPUT` before any Worker is loaded.

| `RunLimits` property             | Meaning                              | Default | Minimum |   Maximum |
| -------------------------------- | ------------------------------------ | ------: | ------: | --------: |
| `timeoutMs`                      | Parent-owned wall timeout            |  30,000 |       1 |   300,000 |
| `cpuMs`                          | Child CPU budget                     |   5,000 |       1 |   300,000 |
| `subRequests`                    | Child subrequest budget              |     256 |       1 |    10,000 |
| `maxSourceBytes`                 | Submitted source UTF-8 bytes         | 262,144 |       1 | 1,048,576 |
| `maxLogBytes`                    | Retained console-message UTF-8 bytes | 262,144 |      25 | 1,048,576 |
| `maxHostFunctionCalls`           | Started host calls                   |     256 |       1 |     4,096 |
| `maxConcurrentHostFunctionCalls` | Simultaneously unsettled host calls  |       8 |       1 |        32 |

Memory, stack size, payload bytes, and worker pooling are not configurable —
Dynamic Workers do not expose per-child memory controls, and Workers RPC owns
message size.

`timeoutMs` interrupts a child that is _waiting_; a child spinning
synchronously cannot be preempted by parent timers and is stopped by its
`cpuMs` budget instead (rejecting with `RUN_RESOURCE_LIMIT`).

## Not in v0.1

- Codemode or Computer integration.
- Alternate execution backends (Node.js, containers, QuickJS, browsers).
- A public executor/provider/dispatcher interface or `createRunner()`.
- Interruptions, approvals, continuations, replay, or deterministic time.
- Caller bindings, caller modules, npm resolution, or configurable outbound
  access.
- Live log streaming.
- Caller-configurable compatibility dates or payload byte limits.

## License

MIT
