# Long-Running Agent — Durable Fibers Demo

Demonstrates durable long-running execution with fibers — fire-and-forget work that survives Durable Object eviction via SQLite checkpointing and alarm-based recovery.

## What it shows

- **`spawnFiber()`** — start a multi-step research task that runs in the background
- **`stashFiber()`** — checkpoint progress after each step (persisted in SQLite)
- **`onFiberRecovered()`** — automatically resume from the last checkpoint after eviction
- **`cancelFiber()`** — stop a running fiber
- **Simulated eviction** — demonstrates the recovery flow without waiting for a real eviction

## Run it

```bash
npm install
cd examples/long-running-agent
npm start
```

No API keys needed — research steps are simulated with delays.
