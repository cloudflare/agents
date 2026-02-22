# Forever Fibers — Durable Execution Demo

> **WARNING: EXPERIMENTAL.** This example uses APIs from `agents/experimental/forever` that are under active development and **will break** between releases. Do not use in production. Pin your package versions and expect to rewrite your code when upgrading.

Demonstrates durable long-running execution with fibers — fire-and-forget work that survives Durable Object eviction via SQLite checkpointing and alarm-based recovery.

See [forever.md](../forever.md) for the full design doc.

## What it shows

- `withFibers` mixin from `agents/experimental/forever`
- `spawnFiber()` — start a multi-step research task that runs in the background
- `stashFiber()` — checkpoint progress after each step (persisted in SQLite)
- `onFiberRecovered()` — automatically resume from the last checkpoint after eviction
- `cancelFiber()` — stop a running fiber
- Simulated eviction — demonstrates the recovery flow

## Run it

```bash
npm install
cd experimental/forever-fibers
npm start
```

No API keys needed — research steps are simulated with delays.
