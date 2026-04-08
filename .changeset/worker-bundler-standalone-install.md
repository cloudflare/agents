---
"@cloudflare/worker-bundler": minor
---

Export `installDependencies`, `hasDependencies`, and `InstallResult` so callers
can pre-warm a `FileSystem` with npm packages independently of `createWorker` or
`createApp`.

When `createWorker` or `createApp` encounter a `FileSystem` that already contains
a package under `node_modules/`, that package is skipped during installation,
avoiding redundant network fetches. This makes a second call to
`installDependencies` (or the internal call inside `createWorker`) a no-op for
packages that were pre-installed into the same `FileSystem`.
