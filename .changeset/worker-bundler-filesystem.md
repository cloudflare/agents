---
"@cloudflare/worker-bundler": minor
---

Introduce `FileSystem` abstraction for all bundler APIs.

The `files` option on `createWorker` and `createApp` now accepts any `FileSystem`
implementation in addition to a plain `Record<string, string>`. This lets callers
back the virtual filesystem with persistent or custom storage — for example, a
`DurableObjectKVFileSystem` that buffers writes in memory and flushes to Durable
Object KV on demand, avoiding a KV write for every individual file operation.

Two concrete implementations are exported from the package:

- `InMemoryFileSystem` — a `Map`-backed filesystem suitable for tests and
  in-process pipelines. Accepts an optional seed object or `Map` of initial
  files.
- `DurableObjectKVFileSystem` — a Durable Object KV-backed filesystem with a
  write-overlay. Writes accumulate in memory and are flushed to KV in one batch
  when `flush()` is called. Reads are served from the overlay first, so callers
  always observe their own writes immediately.

The `FileSystem.read()` method returns `string | null` (null = file does not
exist) rather than an empty string, eliminating the need for a separate
`exists()` check.

Plain `Record<string, string>` objects continue to work unchanged — they are
wrapped in an `InMemoryFileSystem` automatically.
