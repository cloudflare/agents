# Forever Fibers — Durable Execution Demo

Demonstrates durable long-running execution with `Agent.runFiber()` — work that survives Durable Object eviction via SQLite checkpointing and alarm-based recovery.

See [forever.md](../forever.md) for the full design doc.

## What it shows

- `runFiber()` — start a multi-step research task that runs in the background
- `ctx.stash()` — checkpoint progress after each step (persisted in SQLite)
- `onFiberRecovered()` — automatically resume from the last checkpoint after eviction
- Real eviction testing — kill the wrangler process externally and restart; alarms persist to disk, so recovery happens automatically (same as production)

## Run it

```bash
npm install
cd experimental/forever-fibers
npm start
```

No API keys needed — research steps are simulated with delays.
