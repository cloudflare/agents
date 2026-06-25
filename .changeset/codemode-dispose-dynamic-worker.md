---
"@cloudflare/codemode": patch
---

Dispose the dynamically-loaded Worker and its RPC entrypoint stub after each
`DynamicWorkerExecutor.execute()` run.

Each execution spins up a child Worker via `loader.load()` and obtains an RPC
`Fetcher` stub via `getEntrypoint()`. These own native handles, and the code
previously left them for the garbage collector. When such a handle is finalized
late — for example during isolate shutdown under
`@cloudflare/vitest-pool-workers` — workerd raises a fatal assertion ("tried to
defer destruction during isolate shutdown") that kills the worker, surfacing as
a flaky "Worker exited unexpectedly" with no failing assertion. The milder
manifestation is workerd's "An RPC result was not disposed properly" warning.

The executor now disposes the entrypoint stub and the loaded worker in `finally`
blocks (best-effort, via `Symbol.dispose`), releasing the handles while the
isolate is still alive. No behavior or API change for callers.
